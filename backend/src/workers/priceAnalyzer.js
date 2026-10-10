const { Worker } = require('bullmq');
const queues = require('../queues');
const Product = require('../models/Product');
const Category = require('../models/Category');
const { calculateRecommendedPrice } = require('../services/priceRecommendation');
const { sweepStalePrices } = require('../services/priceSweep');

const SWEEP_NAME = 'price-refinement-sweep';

async function refinePrice(productId) {
  const product = await Product.findById(productId).populate('category');
  if (!product) throw new Error('Product not found');

  const comparables = await Product.find({
    category: product.category?._id,
    status: 'sold',
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('price condition brand model');

  const priceRec = await calculateRecommendedPrice({
    category: product.category,
    brand: product.brand,
    model: product.model,
    originalPrice: product.originalPrice,
    yearsUsed: product.yearsUsed,
    condition: product.condition,
    cvConditionScore: product.aiAnalysis?.conditionScore == null ? null : product.aiAnalysis.conditionScore,
    damageScore: product.aiAnalysis?.damageScore == null ? null : product.aiAnalysis.damageScore,
    specifications: product.specifications,
    comparableListings: comparables,
  });

  // Same ML blend as imageProcessor — a later local-only recompute must not
  // silently clobber the ML-informed price the upload worker already stored.
  let price = priceRec;
  try {
    const mlClient = require('../services/mlClient');
    const primaryUrl = product.images?.[0]?.url;
    let embedding = null;
    if (product.embedding && product.embedding.length === 512) {
      embedding = product.embedding;
    } else if (primaryUrl) {
      embedding = await mlClient.getEmbedding(primaryUrl);
    }
    const mlPrice = await mlClient.estimatePrice({
      listing: {
        title: product.title,
        brand: product.brand,
        model: product.model,
        originalPrice: product.originalPrice,
        yearsUsed: product.yearsUsed,
        condition: product.condition,
        category: product.category?._id,
      },
      embedding,
      imageUrl: primaryUrl,
      comparables: comparables.map((c) => ({
        id: c._id.toString(),
        price: c.price,
        originalPrice: c.originalPrice,
        condition: c.condition,
        category: c.category?.toString(),
        embedding: c.embedding,
      })),
    });
    if (mlPrice) {
      price = mlClient.blendWithMl(priceRec, mlPrice);
    }
  } catch (err) {
    console.warn(`[PriceWorker] ML price blend failed, keeping local baseline: ${err.message}`);
  }

  await Product.findByIdAndUpdate(productId, {
    'aiAnalysis.priceRecommendation': {
      recommendedPrice: price.recommendedPrice,
      minPrice: price.minPrice,
      maxPrice: price.maxPrice,
      confidence: price.confidence,
      explanation: price.explanation,
      factors: price.factors,
      source: price.source,
      generatedAt: product.aiAnalysis?.priceRecommendation?.generatedAt || new Date(),
      refinedAt: new Date(),
    },
  });
}

(async () => {
  // The queue module resolves its shared Redis connection asynchronously —
  // wait for it before constructing the BullMQ Worker. Exit non-zero when
  // Redis is unavailable so the container restart policy retries.
  try {
    await queues.whenConnected;
  } catch (err) {
    console.error('[PriceWorker] Redis unavailable, exiting:', err.message);
    process.exit(1);
  }

  const { connection, priceAnalysisQueue } = queues;

  const priceAnalysisWorker = new Worker(
    'price-analysis',
    async (job) => {
      // Dispatch based on job name
      if (job.name === SWEEP_NAME) {
        console.log('[PriceWorker] Running price-refinement-sweep');
        const result = await sweepStalePrices({
          enqueue: async (productId) => {
            await priceAnalysisQueue.add('refine-price', { productId }, { delay: 1000 });
          },
        });
        console.log(`[PriceWorker] Sweep result: ${JSON.stringify(result)}`);
        return result;
      }

      // Default: single-product price refinement
      const { productId } = job.data;
      console.log(`[PriceWorker] Re-analyzing price for product ${productId}`);

      await refinePrice(productId);

      console.log(`[PriceWorker] Completed price analysis for product ${productId}`);
      return { success: true, productId };
    },
    { connection, concurrency: 2 }
  );

  priceAnalysisWorker.on('completed', (job) => {
    console.log(`[PriceWorker] Job ${job.id} (${job.name || 'refine-price'}) completed`);
  });

  priceAnalysisWorker.on('failed', (job, err) => {
    console.error(`[PriceWorker] Job ${job?.id} (${job?.name || 'refine-price'}) failed:`, err.message);
  });

  console.log('[PriceWorker] Price analysis worker started');

  process.on('SIGINT', async () => {
    await priceAnalysisWorker.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await priceAnalysisWorker.close();
    process.exit(0);
  });
})();
