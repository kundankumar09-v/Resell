const { Worker } = require('bullmq');
const queues = require('../queues');
const Product = require('../models/Product');
const Category = require('../models/Category');
const {
  perceptualHashFromBuffer,
  mirrorPerceptualHashFromBuffer,
  orientationHashesFromBuffer,
} = require('../services/imageHash');
const { createCVProvider } = require('../services/cvAdapter');
const { analyzeDetectedObjects } = require('../services/imageClassifier');
const { extractColorHistogram, downloadImageBuffer } = require('../services/imageUtils');
const cvProvider = createCVProvider();
const { calculateRecommendedPrice } = require('../services/priceRecommendation');
const { detectRisk, fuseFraudScores } = require('../services/fraudDetection');
const {
  assessCategoryAgreement,
  assessCrossCategoryImageRepost,
} = require('../services/fraudDetection');
const { cosineSimilarity } = require('../services/textSimilarity');

(async () => {
  // The queue module resolves its shared Redis connection asynchronously —
  // wait for it before constructing the BullMQ Worker. Exit non-zero when
  // Redis is unavailable so the container restart policy retries.
  try {
    await queues.whenConnected;
  } catch (err) {
    console.error('[Worker] Redis unavailable, exiting:', err.message);
    process.exit(1);
  }

  const { connection } = queues;

  const imageProcessingWorker = new Worker(
    'image-processing',
    async (job) => {
    const { productId, images, productData } = job.data;

    try {
      console.log(`[Worker] Processing images for product ${productId}`);

      const results = [];
      for (const image of images) {
        let buffer;
        if (image.buffer) {
          buffer = Buffer.from(image.buffer);
        } else if (image.url) {
          const res = await fetch(image.url);
          if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
          buffer = Buffer.from(await res.arrayBuffer());
        } else {
          throw new Error('No image buffer or URL provided');
        }

        // Images were already uploaded to Cloudinary during the request.
        // Reuse the existing URL/publicId instead of uploading again.
        const hash = await perceptualHashFromBuffer(buffer);
        const mirrorHash = await mirrorPerceptualHashFromBuffer(buffer);
        const { rotationHashes, vflipHash } = await orientationHashesFromBuffer(buffer);

        // Extract color histogram
        const colorHistogram = await extractColorHistogram(buffer);

        const [condition, damage, classification] = await Promise.all([
          cvProvider.assessCondition(buffer),
          cvProvider.detectDamage(buffer),
          cvProvider.classifyProduct(buffer, {
            filename: image.originalname || 'image.jpg',
            title: productData.title,
          }),
        ]);

        // Multi-object analysis (README §7.12): COCO-SSD boxes → per-crop
        // MobileNet classification + CNN embedding. Best-effort and never
        // blocking — no detections or any failure yields [] and the
        // whole-image analysis above applies exactly as before.
        let detectedObjects = [];
        let detectedImageWidth = 0;
        let detectedImageHeight = 0;
        try {
          const multi = await analyzeDetectedObjects(buffer, {
            filename: image.originalname || 'image.jpg',
            title: productData.title,
          });
          if (Array.isArray(multi.objects)) detectedObjects = multi.objects;
          detectedImageWidth = multi.imageWidth || 0;
          detectedImageHeight = multi.imageHeight || 0;
        } catch (err) {
          console.warn('[Worker] Multi-object analysis warning:', err.message);
        }

        results.push({
          url: image.url,
          publicId: image.publicId,
          hash,
          mirrorHash,
          rotationHashes,
          vflipHash,
          colorHistogram,
          detectedObjects,
          detectedImageWidth,
          detectedImageHeight,
          analysis: {
            conditionScore: condition.score,
            damageScore: damage.score,
            predictedCategory: classification.category,
            classificationConfidence: classification.confidence,
          },
        });
      }

      if (results.length === 0) {
        throw new Error('No images processed successfully');
      }

      // Average CV scores across images. Unavailable analysis (null score)
      // is skipped — a missing visual estimate is never fabricated as 0.
      const conditionScores = results
        .map((r) => r.analysis?.conditionScore)
        .filter((s) => typeof s === 'number' && Number.isFinite(s));
      const damageScores = results
        .map((r) => r.analysis?.damageScore)
        .filter((s) => typeof s === 'number' && Number.isFinite(s));
      const avgCondition =
        conditionScores.length > 0
          ? conditionScores.reduce((s, v) => s + v, 0) / conditionScores.length
          : null;
      const avgDamage =
        damageScores.length > 0
          ? damageScores.reduce((s, v) => s + v, 0) / damageScores.length
          : null;
      const damageLevel =
        avgDamage === null ? null : avgDamage >= 50 ? 'high' : avgDamage >= 25 ? 'medium' : 'low';
      // Primary product selection (README §7.12): the cover image's objects
      // arrive sorted by detection score, so index 0 is the default primary.
      // A seller override (PUT primaryObjectIndex) survives re-runs: it is
      // honoured whenever it still points at a detected object.
      const coverObjects = Array.isArray(results[0]?.detectedObjects)
        ? results[0].detectedObjects
        : [];
      const multiObject = coverObjects.length >= 2;
      const storedPrimary = await Product.findById(productId)
        .select('aiAnalysis.primaryObjectIndex')
        .lean();
      const storedIndex = storedPrimary?.aiAnalysis?.primaryObjectIndex;
      const primaryObjectIndex =
        Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < coverObjects.length
          ? storedIndex
          : 0;
      let predictedCategory = results[0]?.analysis?.predictedCategory || 'Other';
      let classificationConfidence = results[0]?.analysis?.classificationConfidence || 0;
      if (multiObject) {
        const primary = coverObjects[primaryObjectIndex];
        if (primary && primary.cropClassification && primary.cropClassification !== 'Other') {
          predictedCategory = primary.cropClassification;
          classificationConfidence = primary.cropConfidence || 0;
        }
      }
      // Bundle photo note (>= 3 objects): informational only, never a risk
      // signal. Displayed to admins/owners; stripped for other viewers.
      let bundleNote = '';
      if (coverObjects.length >= 3) {
        const labels = coverObjects.slice(0, 5).map((o) => o.label).join(', ');
        bundleNote =
          `Bundle photo: ${coverObjects.length} distinct items detected (${labels}). ` +
          'Categorized by the primary item; review the remaining items manually.';
      }

      const category = await Category.findById(productData.category);

      // Category-agreement signal (README §7.9): compare the MobileNet-predicted
      // category to the seller's chosen category. Only a confident disagreement
      // fires (+10); when it does, the suggested category is added to the pHash
      // probe pool so a miscategorised repost cannot dodge the same-category
      // gate (cross-category scan routing).
      const categoryAgreement = assessCategoryAgreement({
        predictedCategory,
        confidence: classificationConfidence,
        chosenCategoryName: category?.name,
      });
      let suggestedCategoryId = null;
      if (categoryAgreement.mismatch) {
        const escaped = String(predictedCategory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const suggested = await Category.findOne({
          name: { $regex: `^${escaped}$`, $options: 'i' },
        }).select('_id');
        suggestedCategoryId = suggested?._id || null;
      }
      const additionalScanCategories =
        categoryAgreement.mismatch && suggestedCategoryId ? [suggestedCategoryId] : [];

      const comparables = await Product.find({
        category: productData.category,
        status: { $in: ['active', 'sold'] },
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .select('price condition brand model originalPrice yearsUsed embedding');

      // Local baseline calculation
      const priceRec = await calculateRecommendedPrice({
        category,
        brand: productData.brand,
        model: productData.model,
        originalPrice: productData.originalPrice,
        yearsUsed: productData.yearsUsed,
        condition: productData.condition,
        cvConditionScore: avgCondition !== null ? Math.round(avgCondition) : null,
        damageScore: avgDamage !== null ? Math.round(avgDamage) : null,
        specifications: productData.specifications,
        comparableListings: comparables,
      });

      // ML Microservice integration: CLIP Embedding, kNN Price Estimation, Fraud Check
      const mlClient = require('../services/mlClient');
      const primaryUrl = results[0]?.url;
      let clipEmbedding = [];

      try {
        if (primaryUrl) {
          const emb = await mlClient.getEmbedding(primaryUrl);
          if (emb && emb.length === 512) {
            clipEmbedding = emb;
          }
        }
      } catch (err) {
        console.warn('[Worker] ML embedding extraction warning:', err.message);
      }

      // Image–text mismatch (supporting-only v1 signal, README §7.9). Requires
      // BOTH the CLIP image embedding and a CLIP text embedding of the title —
      // when the ML service is down getTextEmbedding returns null and the check
      // is skipped silently (no error, no risk points).
      let imageTextSimilarity = null;
      if (clipEmbedding.length === 512 && productData.title) {
        try {
          const titleEmbedding = await mlClient.getTextEmbedding(productData.title);
          if (titleEmbedding) {
            imageTextSimilarity = cosineSimilarity(clipEmbedding, titleEmbedding);
          }
        } catch (err) {
          console.warn('[Worker] Image-text similarity warning:', err.message);
        }
      }

      // 1. ML Price Estimation — weighted blend with the local heuristic so
      // the transparent baseline is never wholesale-overridden.
      const { blendWithMl } = require('../services/mlClient');
      let finalSuggestedPrice = priceRec.recommendedPrice;
      let finalPriceRange = {
        min: priceRec.minPrice,
        max: priceRec.maxPrice,
        p25: priceRec.minPrice,
        p75: priceRec.maxPrice,
      };
      let priceExplanation = priceRec.explanation;
      let priceFactors = priceRec.factors;
      let priceSource = priceRec.source;
      let priceConfidence = priceRec.confidence;

      try {
        const mlPrice = await mlClient.estimatePrice({
          listing: {
            ...productData,
            condition: productData.condition,
            originalPrice: productData.originalPrice,
            yearsUsed: productData.yearsUsed,
            category: productData.category,
          },
          embedding: clipEmbedding.length === 512 ? clipEmbedding : null,
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
          const blended = blendWithMl(priceRec, mlPrice);
          finalSuggestedPrice = blended.recommendedPrice;
          finalPriceRange = {
            min: blended.minPrice,
            max: blended.maxPrice,
            p25: blended.minPrice,
            p75: blended.maxPrice,
          };
          priceExplanation = blended.explanation;
          priceFactors = blended.factors;
          priceSource = blended.source;
          priceConfidence = blended.confidence;
        }
      } catch (err) {
        console.warn('[Worker] ML price estimation warning:', err.message);
      }

      // 2. ML Multi-Modal Fraud Check
      const candidateListingsForFraud = await Product.find({
        _id: { $ne: productId },
        status: { $in: ['active', 'sold', 'pendingReview'] },
      })
        .select('title seller price images embedding aiAnalysis.imageHashes createdAt')
        .limit(100)
        .lean();

      let mlFraud = {
        fraudScore: 0,
        riskLevel: 'low',
        isFlagged: false,
        statusRecommendation: 'active',
        fraudReasons: [],
      };

      try {
        mlFraud = await mlClient.checkFraud({
          listing: {
            _id: productId,
            title: productData.title,
            price: productData.price,
            sellerId: productData.seller || '',
            perceptualHash: results[0]?.hash || '',
            embedding: clipEmbedding,
            imageUrl: primaryUrl,
            images: results.map((r) => ({ url: r.url, hash: r.hash })),
          },
          candidateListings: candidateListingsForFraud.map((cand) => ({
            _id: cand._id.toString(),
            title: cand.title,
            sellerId: cand.seller?.toString() || '',
            embedding: cand.embedding || [],
            imageHashes: cand.aiAnalysis?.imageHashes || (cand.images || []).map((i) => i.perceptualHash).filter(Boolean),
          })),
          categoryMedianPrice: finalSuggestedPrice,
        });
      } catch (err) {
        console.warn('[Worker] ML fraud check warning:', err.message);
      }

      // If fraudScore >= 70 or ML recommended pendingReview, transition listing to pendingReview
      const isHighRisk = mlFraud.fraudScore >= 70 || mlFraud.statusRecommendation === 'pendingReview';
      const updatedStatus = isHighRisk ? 'pendingReview' : 'active';
      const isFlagged = isHighRisk || mlFraud.isFlagged;
      const flagReason = mlFraud.fraudReasons?.length > 0 ? mlFraud.fraudReasons.join('; ') : '';

      // Preserve previously stored hashes — the edit path may have stored
      // mirror/rotation/vflip hashes, and overwriting here would silently erase
      // them (data loss on every background run). Merge: keep all existing
      // entries, add the new unique normal + mirror + orientation hashes.
      const stored = await Product.findById(productId)
        .select('aiAnalysis.imageHashes aiAnalysis.rotationHashes aiAnalysis.vflipHash')
        .lean();
      const newHashes = results.flatMap((r) => [r.hash, r.mirrorHash]).filter(Boolean);
      const mergedHashes = [
        ...new Set([...(stored?.aiAnalysis?.imageHashes || []), ...newHashes]),
      ];
      const newRotations = results.flatMap((r) => r.rotationHashes || []).filter(Boolean);
      const mergedRotations = [
        ...new Set([...(stored?.aiAnalysis?.rotationHashes || []), ...newRotations]),
      ];
      const newVflips = results
        .flatMap((r) => (r.vflipHash ? [r.vflipHash] : []))
        .filter(Boolean);
      const mergedVflips = [
        ...new Set([...(stored?.aiAnalysis?.vflipHash || []), ...newVflips]),
      ];

      const product = await Product.findByIdAndUpdate(
        productId,
        {
          embedding: clipEmbedding,
          fraudScore: mlFraud.fraudScore,
          fraudReasons: mlFraud.fraudReasons || [],
          suggestedPrice: finalSuggestedPrice,
          priceRange: finalPriceRange,
          status: updatedStatus,
          isFlagged,
          ...(flagReason ? { flagReason } : {}),
          images: results.map((r, idx) => ({
            url: r.url,
            publicId: r.publicId,
            isPrimary: idx === 0,
            perceptualHash: r.hash,
            colorHistogram: r.colorHistogram,
            productType: 'unknown',
          })),
          aiAnalysis: {
            classification: {
              predictedCategory,
              confidence: classificationConfidence,
            },
            conditionScore: avgCondition !== null ? Math.round(avgCondition) : 0,
            conditionConfidence: conditionScores.length > 0 ? 0.65 : 0.3,
            damageScore: avgDamage !== null ? Math.round(avgDamage) : 0,
            damageLevel,
            damageConfidence: damageScores.length > 0 ? 0.6 : 0.3,
            visualAnalysisAvailable: avgCondition !== null || avgDamage !== null,
            damageDescription: '',
            imageHashes: mergedHashes,
            rotationHashes: mergedRotations,
            vflipHash: mergedVflips,
            priceRecommendation: {
              recommendedPrice: finalSuggestedPrice,
              minPrice: finalPriceRange.min,
              maxPrice: finalPriceRange.max,
              confidence: priceConfidence,
              explanation: priceExplanation,
              factors: priceFactors,
              source: priceSource,
              generatedAt: new Date(),
            },
            // Image↔title CLIP cosine similarity (null when the ML service was
            // down). Persisted so later edit re-scores reproduce the signal.
            imageTextSimilarity:
              typeof imageTextSimilarity === 'number' ? imageTextSimilarity : null,
            // Cover-image multi-object detections (§7.12). The primary
            // (first) image drives the listing-level objects; per-image crop
            // detail is recomputed on demand, never persisted per image.
            detectedObjects: Array.isArray(results[0]?.detectedObjects)
              ? results[0].detectedObjects
              : [],
            detectedImageWidth: results[0]?.detectedImageWidth || 0,
            detectedImageHeight: results[0]?.detectedImageHeight || 0,
            multiObject,
            primaryObjectIndex: coverObjects.length > 0 ? primaryObjectIndex : null,
            bundleNote,
            riskAssessment: {
              riskScore: mlFraud.fraudScore,
              riskLevel: mlFraud.riskLevel,
              factors: mlFraud.fraudReasons || [],
              assessedAt: new Date(),
            },
            lastAnalyzedAt: new Date(),
          },
        },
        { new: true }
      );

      if (!product) {
        throw new Error('Product not found');
      }

      // Extract CNN features for duplicate detection (async, non-blocking)
      // This is done in background to not slow down the worker. The visual
      // risk assessment below waits for the main flow's riskAssessment write
      // to complete first (mainFlowDone), so the supporting visual signal can
      // never be overwritten by the main flow's product.save() — and can
      // never overwrite it either.
      let resolveMainFlowDone;
      const mainFlowDone = new Promise((resolve) => {
        resolveMainFlowDone = resolve;
      });

      setImmediate(async () => {
        try {
          const axios = require('axios');
          const mlServiceUrl = process.env.ML_SERVICE_URL || 'http://localhost:5000';
          const mlClient = axios.create({ baseURL: mlServiceUrl, timeout: 15000 });

          for (const image of images) {
            if (image.url) {
              try {
                const response = await mlClient.post('/extract-cnn', { imageUrl: image.url });
                if (response.data?.features?.length) {
                  // Update product with CNN features
                  await Product.findByIdAndUpdate(productId, {
                    $set: {
                      'images.$[elem].cnnFeatures': response.data.features,
                      'images.$[elem].productType': response.data.product_type || 'unknown',
                    },
                  }, {
                    arrayFilters: [{ 'elem.url': image.url }],
                  });
                }
              } catch (e) {
                // ML unavailability is a warning, never a fraud signal —
                // listing creation does not depend on the ML service.
                console.warn(`[Worker] CNN extraction failed for ${image.url}:`, e.message);
              }
            }
          }

          // Wait until the main flow has finished writing its riskAssessment
          // so the visual signal below cannot be lost or clobbered.
          await mainFlowDone;

          // Visual product fingerprint comparison (SCRUM-25): CNN features
          // are compared crosswise against other listings. Supporting risk
          // signal only — a visual match never blocks or flags on its own.
          // Best-effort: failures here are warnings, never job failures.
          try {
            const { assessVisualSimilarity } = require('../services/fraudDetection');
            const visual = await assessVisualSimilarity({ productId });
            if (visual.available && visual.signal) {
              // Atomic aggregation-pipeline update — appends the visual
              // factor, increments the score and re-derives the level in a
              // single server-side operation (no read-modify-write race).
              await Product.updateOne(
                { _id: productId },
                [
                  {
                    $set: {
                      'aiAnalysis.riskAssessment.factors': {
                        $concatArrays: [
                          { $ifNull: ['$aiAnalysis.riskAssessment.factors', []] },
                          [visual.factor],
                        ],
                      },
                      'aiAnalysis.riskAssessment.riskScore': {
                        $min: [
                          100,
                          {
                            $add: [
                              { $ifNull: ['$aiAnalysis.riskAssessment.riskScore', 0] },
                              visual.weight || 0,
                            ],
                          },
                        ],
                      },
                    },
                  },
                  {
                    $set: {
                      'aiAnalysis.riskAssessment.riskLevel': {
                        $cond: [
                          { $gte: ['$aiAnalysis.riskAssessment.riskScore', 50] },
                          'high',
                          {
                            $cond: [
                              { $gte: ['$aiAnalysis.riskAssessment.riskScore', 25] },
                              'medium',
                              'low',
                            ],
                          },
                        ],
                      },
                      'aiAnalysis.riskAssessment.assessedAt': new Date(),
                    },
                  },
                ]
              );
            }
          } catch (e) {
            console.warn(`[Worker] Visual fingerprint comparison failed for ${productId}:`, e.message);
          }
        } catch (e) {
          console.warn(`[Worker] Background CNN extraction failed for ${productId}:`, e.message);
        }
      });

      // Cross-category CLIP image-repost scan (README §7.11): platform-wide and
      // cross-seller. Requires a 512-D CLIP embedding — skipped silently when
      // the ML service is down. detectRisk suppresses it when pHash already
      // fired so it can never exceed the pHash duplicate weight.
      let crossCategoryRepost = null;
      if (clipEmbedding.length === 512) {
        crossCategoryRepost = await assessCrossCategoryImageRepost({
          productId: product._id,
          embedding: clipEmbedding,
          sellerId: product.seller?._id || product.seller,
        });
      }

      try {
        const risk = await detectRisk({
          product,
          hashes: product.aiAnalysis.imageHashes,
          aiAnalysis: product.aiAnalysis,
          imageTextSimilarity,
          categoryMismatch: categoryAgreement.mismatch,
          additionalScanCategories,
          crossCategoryRepost,
        });

        // v1/v2 score fusion (README §8.4): when the ML service returned a
        // calibrated v2 probability, take the max of the two engines so either
        // can escalate but neither can downgrade the other. Legacy pipeline or
        // ML-unavailable -> v1 only.
        const fusion = fuseFraudScores({
          v1RiskScore: risk.riskScore,
          v2FraudProbability: mlFraud.fraudProbability,
        });

        product.aiAnalysis.riskAssessment = {
          riskScore: fusion.riskScore,
          riskLevel: fusion.riskLevel,
          factors: risk.factors,
          riskFactorCategories: risk.riskFactorCategories,
          v1RiskScore: fusion.v1RiskScore,
          v2FraudProbability: fusion.v2FraudProbability,
          fusionMode: fusion.fusionMode,
          assessedAt: new Date(),
        };

        await product.save();
      } finally {
        // The main flow's riskAssessment write is done (or has failed) —
        // the background visual block may proceed. Always resolve so it can
        // never hang the worker's event loop.
        resolveMainFlowDone();
      }

      try {
        const { priceAnalysisQueue } = require('../queues');
        await priceAnalysisQueue.add('reprice', { productId }, { delay: 30000 });
      } catch (err) {
        console.warn(`[Worker] Could not enqueue price-analysis job for ${productId}: ${err.message}`);
      }

      console.log(`[Worker] Completed processing for product ${productId}`);
      return { success: true, productId };
    } catch (error) {
      console.error(`[Worker] Error processing product ${productId}:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 2,
  }
);

  imageProcessingWorker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed`);
  });

  imageProcessingWorker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  console.log('[Worker] Image processing worker started');

  process.on('SIGINT', async () => {
    console.log('[Worker] Shutting down...');
    await imageProcessingWorker.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[Worker] Shutting down...');
    await imageProcessingWorker.close();
    process.exit(0);
  });
})();