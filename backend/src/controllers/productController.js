const Product = require('../models/Product');
const ImageUploadRecord = require('../models/ImageUploadRecord');
const Category = require('../models/Category');
const User = require('../models/User');
const ProductIdentity = require('../models/ProductIdentity');
const Review = require('../models/Review');
const Sale = require('../models/Sale');
const { REVIEWABLE_STATUSES } = require('../models/Sale');
const AppError = require('../utils/AppError');
const { uploadToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');
const {
  perceptualHashFromBuffer,
  mirrorPerceptualHashFromBuffer,
  orientationHashesFromBuffer,
  hammingDistance,
} = require('../services/imageHash');
const computerVision = require('../services/computerVision');
const SHARED_LIMITS = require('../constants');
const { calculateRecommendedPrice } = require('../services/priceRecommendation');
const { detectRisk, collectHashSet, assessCategoryAgreement } = require('../services/fraudDetection');
const {
  verifyOwnershipForListing,
  verifyPossession,
  requestPossessionChallenge,
  recordSaleProvenance,
  SIGNALS,
} = require('../services/identityVerification');
const { isIdentifierEligible, isIdentifierTypeValidForCategory, createProvenanceEvent, verifyProvenanceChain } = require('../services/provenance');
const { findSimilar } = require('../services/similarProducts');
const { imageProcessingQueue } = require('../queues');

const buildFilters = (query) => {
  const filter = { status: 'active' };

  if (query.q) {
    filter.$text = { $search: query.q };
  }
  if (query.category) filter.category = query.category;
  if (query.brand) {
    const escaped = query.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.brand = new RegExp(`^${escaped}$`, 'i');
  }
  if (query.condition) filter.condition = query.condition;
  if (query.minPrice !== undefined && query.minPrice !== '' && query.minPrice !== null) {
    filter.price = filter.price || {};
    filter.price.$gte = Number(query.minPrice);
  }
  if (query.maxPrice !== undefined && query.maxPrice !== '' && query.maxPrice !== null) {
    filter.price = filter.price || {};
    filter.price.$lte = Number(query.maxPrice);
  }
  if (query.location) {
    const escaped = query.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter['location.city'] = new RegExp(escaped, 'i');
  }
  if (query.seller) filter.seller = query.seller;

  return filter;
};

const buildSort = (sort) => {
  switch (sort) {
    case 'price-asc':
      return { price: 1 };
    case 'price-desc':
      return { price: -1 };
    case 'newest':
      return { createdAt: -1 };
    case 'oldest':
      return { createdAt: 1 };
    case 'popular':
      return { views: -1, favoritesCount: -1 };
    default:
      return { createdAt: -1 };
  }
};

const getProducts = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const skip = (page - 1) * limit;

    const filter = buildFilters(req.query);
    const isTextSearch = !!filter.$text;

    // When using $text search, MongoDB requires sorting by textScore
    let sort;
    if (isTextSearch) {
      sort = { score: { $meta: 'textScore' } };
    } else {
      sort = buildSort(req.query.sort);
    }

    let query = Product.find(filter)
      .populate('category', 'name slug')
      .populate('seller', 'name avatar location averageResponseMinutes')
      .sort(sort)
      .skip(skip)
      .limit(limit);

    // Add textScore to returned documents when using text search
    if (isTextSearch) {
      query = query.select({ score: { $meta: 'textScore' } });
    }

    const [items, total] = await Promise.all([
      query,
      Product.countDocuments(filter),
    ]);

    res.json({
      success: true,
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

const getProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('category', 'name slug')
      .populate('seller', 'name avatar location bio averageResponseMinutes createdAt isVerified');

    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');

    const isOwner =
      req.user && req.user._id.toString() === product.seller._id.toString();

    // Increment views (best-effort)
    if (!isOwner) {
      Product.updateOne({ _id: product._id }, { $inc: { views: 1 } }).catch(() => {});
      // Internal fraud/moderation scores are never exposed to buyers or
      // anonymous viewers — only the owner (and admins) see the listing's
      // own risk assessment. The bundle-photo note is likewise admin/owner-only.
      if (product.aiAnalysis && req.user?.role !== 'admin') {
        product.aiAnalysis.riskAssessment = undefined;
        product.aiAnalysis.bundleNote = undefined;
      }
    }

    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
};

// Maximum hamming distance for 64-bit pHash to consider two images as duplicates.
// Distance 0-8: very likely duplicate (crop/recompress variants).
// Distance 9-12: possibly similar (captured to be safe).
// Distance 13+: genuinely different images.
// Threshold of 12 matches fraudDetection.js HASH_SIMILARITY_THRESHOLD and is
// validated against real photographs with a margin of 18 points to the next
// same-category different-product minimum distance (30). Both share the
// single HASH_SIMILARITY_THRESHOLD env var (defaulted in
// config/validateEnv.js), consumed via SHARED_LIMITS.DUPLICATE_HASH_THRESHOLD.
const DUPLICATE_HASH_THRESHOLD = SHARED_LIMITS.DUPLICATE_HASH_THRESHOLD;

const uploadImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw new AppError('No images provided', 400, 'NO_FILES');
    }

    // Phase 1: Compute perceptual hashes (normal + mirrored + rotation +
    // vertical-flip variants) for ALL incoming images before any Cloudinary
    // upload. This ensures we can reject duplicates without leaving orphaned
    // files on Cloudinary. The mirrored hash counters the flipped-image
    // evasion tactic; the rotation/vflip hashes counter rotated and
    // upside-down re-uploads: a rotated stolen upload's own hash matches the
    // original's stored rotation hash for the same angle.
    const fileHashes = [];
    for (const file of req.files) {
      const hash = await perceptualHashFromBuffer(file.buffer);
      const mirrorHash = await mirrorPerceptualHashFromBuffer(file.buffer);
      const { rotationHashes, vflipHash } = await orientationHashesFromBuffer(file.buffer);
      fileHashes.push({ file, hash, mirrorHash, rotationHashes, vflipHash });
    }

    // Phase 2: Check each hash against existing active/sold products.
    // The check is deliberately GLOBAL, never scoped by a client-supplied
    // category — the eventual listing's category is chosen later in
    // POST /api/products, so trusting a category field here would let a
    // seller scope the check away from the listing that holds the
    // original image. Limited to 500 candidates for performance.
    //
    // The FULL hash set is probed against every stored entry's full hash
    // set — stored aiAnalysis.imageHashes is a flat list mixing normal and
    // mirror entries; rotationHashes/vflipHash hold the orientation
    // variants. Incoming-normal vs stored-mirror catches flipped re-uploads
    // of fixed rows; incoming-mirror vs stored-normal catches legacy rows
    // that never stored mirrors; incoming-rotated vs stored-rotation
    // catches rotated re-uploads of any row.
    for (const { hash, mirrorHash, rotationHashes, vflipHash } of fileHashes) {
      const candidateFilter = {
        status: { $in: ['active', 'sold'] },
        'aiAnalysis.imageHashes': { $exists: true, $ne: [] },
      };

      const candidates = await Product.find(candidateFilter)
        .select('title seller aiAnalysis.imageHashes aiAnalysis.rotationHashes aiAnalysis.vflipHash')
        .limit(500);

      const probeSet = [hash, mirrorHash, ...(rotationHashes || []), vflipHash].filter(Boolean);
      for (const probe of probeSet) {
        if (!probe) continue;
        for (const candidate of candidates) {
          const candidateHashes = collectHashSet(candidate.aiAnalysis);
          for (const candidateHash of candidateHashes) {
            const distance = hammingDistance(probe, candidateHash);
            // null = non-pHash entry (e.g. sha256 fallback) — skip, never compare.
            if (distance !== null && distance <= DUPLICATE_HASH_THRESHOLD) {
              const similarityPct = Math.round((1 - distance / 64) * 100);
              throw new AppError(
                `Duplicate image detected (~${similarityPct}% similar to existing listing "${candidate.title}"). This image is already used in another listing.`,
                409,
                'DUPLICATE_IMAGE'
              );
            }
          }
        }
      }
    }

    // Phase 3: All hashes are unique — proceed with Cloudinary upload + CV analysis.
    const results = [];
      for (const file of req.files) {
      let uploaded = null;
      try {
        uploaded = await uploadToCloudinary(file.buffer, 'resell/products');
        const stored = fileHashes.find((fh) => fh.file === file) || {};
        const hash = stored.hash;
        const mirrorHash = stored.mirrorHash;
        const rotationHashes = stored.rotationHashes || [];
        const vflipHash = stored.vflipHash || '';

        // CV analysis
        const [condition, damage, classification] = await Promise.all([
          computerVision.assessCondition(file.buffer),
          computerVision.detectDamage(file.buffer),
          computerVision.classifyProduct(file.buffer, {
            filename: file.originalname,
            title: req.body.title,
          }),
        ]);

        results.push({
          url: uploaded.url,
          publicId: uploaded.publicId,
          width: uploaded.width,
          height: uploaded.height,
          hash,
          mirrorHash,
          rotationHashes,
          vflipHash,
          analysis: {
            conditionScore: condition.score,
            damageScore: damage.score,
            predictedCategory: classification.category,
            classificationConfidence: classification.confidence,
          },
        });
      } catch (err) {
        console.error('[Upload] Image processing error:', err.message);
        // If the file made it to Cloudinary but analysis failed, the client
        // never received its URL — delete the asset so it is not orphaned.
        if (uploaded?.publicId) {
          await deleteFromCloudinary(uploaded.publicId).catch(() => {});
        }
      }
    }

    if (results.length === 0) {
      throw new AppError('Failed to process images', 500, 'IMAGE_PROCESSING_FAILED');
    }

    // Average CV scores across images. Unavailable analysis (null score)
    // is skipped — a missing visual estimate is never fabricated as 0 or 75.
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
    const predictedCategory = results[0]?.analysis?.predictedCategory || 'Other';
    const classificationConfidence = results[0]?.analysis?.classificationConfidence || 0;

    // SCRUM-31: persist the computed hashes server-side, keyed by
    // (user, publicId). createProduct reads them back instead of trusting
    // the client's echo of this response, so a crafted API call cannot
    // omit or fabricate hashes. Best-effort: a record write failure must
    // never fail the upload itself — the client still receives the hashes
    // and creation falls back to the echo path flagged as unverified.
    try {
      const ops = results
        .filter((r) => r.publicId)
        .map((r) => ({
          updateOne: {
            filter: { user: req.user._id, publicId: r.publicId },
            update: {
              $set: {
                user: req.user._id,
                publicId: r.publicId,
                url: r.url,
                hash: r.hash || null,
                mirrorHash: r.mirrorHash || null,
                rotationHashes: r.rotationHashes || [],
                vflipHash: r.vflipHash || null,
              },
            },
            upsert: true,
          },
        }));
      if (ops.length > 0) {
        await ImageUploadRecord.bulkWrite(ops, { ordered: false });
      }
    } catch (err) {
      console.error('[Upload] Failed to persist image upload records:', err.message);
    }

    res.json({
      success: true,
      images: results.map((r) => ({
        url: r.url,
        publicId: r.publicId,
        width: r.width,
        height: r.height,
        hash: r.hash,
        mirrorHash: r.mirrorHash,
        rotationHashes: r.rotationHashes,
        vflipHash: r.vflipHash,
      })),
      analysis: {
        conditionScore: avgCondition !== null ? Math.round(avgCondition) : null,
        damageScore: avgDamage !== null ? Math.round(avgDamage) : null,
        damageLevel:
          avgDamage === null
            ? null
            : avgDamage >= 50
            ? 'high'
            : avgDamage >= 25
            ? 'medium'
            : 'low',
        predictedCategory,
        classificationConfidence,
        visualAnalysisAvailable: avgCondition !== null || avgDamage !== null,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Server-side re-verification of image analysis.
 *
 * Never trust client-submitted aiAnalysis values: download the stored
 * images and recompute condition/damage/classification with our own
 * heuristic CV pipeline before they influence pricing or storage.
 */
const reverifyImageAnalysis = async (images = [], { title } = {}) => {
  const results = [];
  for (const img of images) {
    if (!img?.url) continue;
    try {
      const res = await fetch(img.url);
      if (!res.ok) throw new Error(`Image fetch failed with status ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const [condition, damage] = await Promise.all([
        computerVision.assessCondition(buffer),
        computerVision.detectDamage(buffer),
      ]);
      results.push({ conditionScore: condition.score, damageScore: damage.score });
    } catch (err) {
      console.error('[CreateProduct] Image re-analysis failed:', err.message);
    }
  }

  if (results.length === 0) {
    return null;
  }

  // Average only the images whose re-analysis produced real evidence —
  // unavailable analysis (null scores) is never fabricated as a number.
  const conditionScores = results
    .map((r) => r.conditionScore)
    .filter((s) => typeof s === 'number' && Number.isFinite(s));
  const damageScores = results
    .map((r) => r.damageScore)
    .filter((s) => typeof s === 'number' && Number.isFinite(s));
  if (conditionScores.length === 0 && damageScores.length === 0) {
    return null;
  }

  const avgCondition =
    conditionScores.length > 0
      ? conditionScores.reduce((s, v) => s + v, 0) / conditionScores.length
      : null;
  const avgDamage =
    damageScores.length > 0
      ? damageScores.reduce((s, v) => s + v, 0) / damageScores.length
      : null;
  const classification = await computerVision.classifyProduct(null, { title });

  return {
    conditionScore: avgCondition !== null ? Math.round(avgCondition) : null,
    damageScore: avgDamage !== null ? Math.round(avgDamage) : null,
    damageLevel:
      avgDamage === null ? null : avgDamage >= 50 ? 'high' : avgDamage >= 25 ? 'medium' : 'low',
    predictedCategory: classification.category,
    classificationConfidence: classification.confidence,
    visualAnalysisAvailable: true,
  };
};

const createProduct = async (req, res, next) => {
  try {
    const {
      title,
      description,
      price,
      originalPrice,
      category,
      brand,
      model,
      condition,
      yearsUsed,
      specifications,
      location,
      images,
      currencyCode,
      identifier,
      identifierType,
      proofImageUrl,
    } = req.body;

    let normalizedIdentifier = typeof identifier === 'string' ? identifier.trim() : '';
    let normalizedIdentifierType = typeof identifierType === 'string' ? identifierType.trim().toLowerCase() : '';

    // Blank or partially supplied identifier metadata must never be coerced into
    // a physical-product registration. Missing identifier data means the listing
    // follows the visual-only possession flow, not an IMEI/serial/VIN flow.
    if (!normalizedIdentifier || !normalizedIdentifierType) {
      normalizedIdentifier = '';
      normalizedIdentifierType = '';
    }
    const hasIdentifierInput = !!(normalizedIdentifier && normalizedIdentifierType);

    if (!title || !description || !price || !category) {
      throw new AppError('Title, description, price and category are required', 400);
    }

    // ── Multi-angle image requirement (server-validated) ────────────────
    // Minimum 3 valid product images (recommended 4-6, maximum 8). The
    // server — never the client — determines the final valid image count.
    // Sellers are guided toward: front/main, back, side/detail and an
    // optional condition/serial area (see SellProduct guidance).
    if (!images || !Array.isArray(images) || images.length < SHARED_LIMITS.MIN_IMAGES) {
      throw new AppError(
        'At least 3 images are required: a front/main view, a back view and a side or detail view. Recommended: 4-6 images.',
        400,
        'TOO_FEW_IMAGES'
      );
    }
    if (images.length > SHARED_LIMITS.MAX_IMAGES) {
      throw new AppError(
        'A listing can have at most 8 images. Please remove the extra images.',
        400,
        'TOO_MANY_IMAGES'
      );
    }

    // ── Server-side hash authority (SCRUM-31) ───────────────────────────
    // The upload-images response is echoed back by the client, so a crafted
    // API call could omit or fabricate hash/mirrorHash and silently bypass
    // duplicate detection and risk flagging. Hashes computed at upload time
    // were persisted server-side keyed by (user, publicId) — they are the
    // source of truth and client-echoed values are ignored whenever a
    // server-side record exists. Images uploaded before this change (or
    // whose record has expired) have no server-side hash: their echoed
    // value is used as a legacy fallback but flagged via
    // aiAnalysis.hashesUnverified so the fraud engine can weight it —
    // legacy listings never hard-fail here.
    const publicIds = images.map((img) => img?.publicId).filter(Boolean);
    const uploadRecords = publicIds.length
      ? await ImageUploadRecord.find({ user: req.user._id, publicId: { $in: publicIds } })
          .select('publicId hash mirrorHash rotationHashes vflipHash')
          .lean()
      : [];
    const recordByPublicId = new Map(uploadRecords.map((r) => [r.publicId, r]));

    let hashesUnverified = false;
    const resolvedImages = images.map((img) => {
      const record = img?.publicId ? recordByPublicId.get(img.publicId) : null;
      if (record && record.hash) {
        return {
          ...img,
          hash: record.hash,
          mirrorHash: record.mirrorHash || null,
          rotationHashes: record.rotationHashes || [],
          vflipHash: record.vflipHash || '',
        };
      }
      if (img?.hash || img?.mirrorHash) hashesUnverified = true;
      return img;
    });

    // NOTE: creation deliberately does NOT hard-block duplicate hashes. The
    // hard 409 gate lives at upload-images (where the raw image bytes are
    // verified server-side). At creation, duplicate hashes flow through the
    // fraud engine's detectRisk() as a +35 risk signal instead — visual
    // similarity alone is never proof of fraud, and identity-verified
    // transfers / legitimate relists may reuse the same image.

    // ── Product identity verification (extension) ──────────────────────
    // For eligible categories with a serial/IMEI/VIN, verify physical
    // ownership. Existing fraud checks (pHash, MobileNet, trust) still run.
    let identityResult = null;
    let identityStatus = null;

    if (hasIdentifierInput) {
      const eligible = await isIdentifierEligible(category);
      if (eligible) {
        // Reject invalid identifier/category combinations (IMEI only for
        // phone-like categories, VIN only for vehicle-like categories).
        const typeValid = await isIdentifierTypeValidForCategory(category, normalizedIdentifierType);
        if (!typeValid) {
          throw new AppError(
            `${normalizedIdentifierType.toUpperCase()} is not a valid identifier for this category. Use a serial number, or the identifier type appropriate for this product.`,
            400,
            'IDENTIFIER_TYPE_INVALID'
          );
        }
        identityResult = await verifyOwnershipForListing({
          rawIdentifier: normalizedIdentifier,
          identifierType: normalizedIdentifierType,
          sellerId: req.user._id,
          proofImageUrl: proofImageUrl || undefined,
        });

        if (identityResult.outcome === 'reported_stolen') {
          throw new AppError(
            'This product identifier has been reported as stolen. Listing blocked.',
            403,
            'IDENTITY_BLOCKED'
          );
        }
        if (identityResult.outcome === 'mismatch') {
          throw new AppError(
            'Ownership verification failed: this serial/IMEI is registered to a different seller with no verified transfer.',
            403,
            'OWNERSHIP_MISMATCH'
          );
        }
        identityStatus = {
          status: identityResult.identity.status,
          verification: {
            verified: !!(identityResult.identity.verification?.verifiedAt),
            method: identityResult.identity.verification?.method || 'none',
            possessionStatus: identityResult.identity.verification?.possessionStatus || 'unverified',
            verificationCode: identityResult.identity.verification?.verificationCode || '',
            codeExpiresAt: identityResult.identity.verification?.codeExpiresAt || null,
          },
          signals: identityResult.signals,
          warnings: identityResult.warnings,
        };
      }
    }

    // Create product with minimal AI analysis (hashes from upload)
    // Full AI analysis will be done in background job. If the listing itself
    // fails to persist, an identity registered during this request must not
    // be orphaned — it is removed again (best-effort) before rethrowing.
    let product;
    try {
      product = await Product.create({
      title,
      description,
      price,
      originalPrice: originalPrice || 0,
      currencyCode: currencyCode ? String(currencyCode).toUpperCase() : 'USD',
      category,
      brand: brand || '',
      model: model || '',
      condition: condition || 'good',
      yearsUsed: yearsUsed || 0,
      specifications: specifications || [],
      location: location || {},
      images: resolvedImages.map((img, idx) => ({
        url: img.url,
        publicId: img.publicId,
        isPrimary: idx === 0,
        ...(img.hash ? { perceptualHash: img.hash } : {}),
      })),
      seller: req.user._id,
      ...(identityResult?.identity ? { productIdentity: identityResult.identity._id } : {}),
      ...(identityResult?.outcome === 'flagged'
        ? { status: 'flagged', isFlagged: true, flagReason: 'Identity flagged — held for moderation' }
        : {}),
      aiAnalysis: {
        classification: {
          predictedCategory: '',
          confidence: 0,
        },
        conditionScore: 0,
        damageScore: 0,
        damageDescription: '',
        // SCRUM-31: hashes come from the server-side upload record when one
        // exists (client echo ignored); legacy images without a server-side
        // hash fall back to the echoed value with hashesUnverified=true.
        imageHashes: resolvedImages.flatMap((i) => [i?.hash, i?.mirrorHash]).filter(Boolean),
        // Rotation/vflip hashes are stored in their own arrays (never mixed
        // into the flat imageHashes list, whose length contract is
        // normal+mirror per image).
        rotationHashes: resolvedImages
          .flatMap((i) => (Array.isArray(i?.rotationHashes) ? i.rotationHashes : [i?.rotationHashes]))
          .filter(Boolean),
        vflipHash: resolvedImages
          .flatMap((i) => (Array.isArray(i?.vflipHash) ? i.vflipHash : i?.vflipHash ? [i.vflipHash] : []))
          .filter(Boolean),
        hashesUnverified,
        priceRecommendation: {
          recommendedPrice: 0,
          minPrice: 0,
          maxPrice: 0,
          confidence: 0,
          explanation: 'AI analysis in progress...',
          factors: [],
          source: 'heuristic',
        },
        lastAnalyzedAt: new Date(),
      },
    });
    } catch (err) {
      // A 'registered' identity created moments ago (before the listing
      // existed) must not be orphaned when the listing itself fails to
      // persist — remove it so the seller can retry cleanly.
      if (identityResult?.outcome === 'registered' && identityResult.identity?._id) {
        await ProductIdentity.deleteOne({ _id: identityResult.identity._id }).catch(() => {});
      }
      throw err;
    }

    // Queue background job for full AI analysis
    await imageProcessingQueue.add('analyze-product', {
      productId: product._id.toString(),
      images: resolvedImages.map(img => ({
        url: img.url,
        publicId: img.publicId,
        hash: img.hash,
      })),
      productData: {
        title,
        description,
        price,
        originalPrice: originalPrice || 0,
        category,
        brand: brand || '',
        model: model || '',
        condition: condition || 'good',
        yearsUsed: yearsUsed || 0,
        specifications: specifications || [],
        location: location || {},
      },
    });

    // LISTED provenance event for tracked identities (server-side only)
    if (identityResult?.identity) {
      const identityDoc = identityResult.identity;
      if (identityResult.outcome === 'registered') {
        // First registration: link identity to the newly created listing
        await ProductIdentity.updateOne(
          { _id: identityDoc._id },
          { $set: { productId: product._id } }
        ).catch(() => {});
        identityDoc.productId = product._id;
      } else if (
        (identityResult.outcome === 'relist' || identityResult.outcome === 'transferred') &&
        identityDoc.productId
      ) {
        // Relist/transfer keeps the identity linked to its original
        // registration — unless the originally registered product no longer
        // exists (dangling ref from a failed creation or a deleted listing),
        // in which case the new listing becomes the linked product.
        const linkedExists = await Product.exists({ _id: identityDoc.productId });
        if (!linkedExists) {
          await ProductIdentity.updateOne(
            { _id: identityDoc._id },
            { $set: { productId: product._id } }
          ).catch(() => {});
          identityDoc.productId = product._id;
        }
      }
      await createProvenanceEvent({
        productIdentityId: identityResult.identity._id,
        eventType: 'listed',
        ownerId: req.user._id,
        listingId: product._id,
      }).catch(() => {});
    }

    // Risk assessment (basic - based on hashes only) — extended with
    // product-identity signals; existing pHash/pricing/trust checks unchanged
    const risk = await detectRisk({
      product,
      hashes: product.aiAnalysis.imageHashes,
      aiAnalysis: product.aiAnalysis,
      identitySignals: identityResult?.signals || [],
      sameOwnerRelist: identityResult?.outcome === 'relist',
    });
    product.aiAnalysis.riskAssessment = {
      riskScore: risk.riskScore,
      riskLevel: identityResult?.outcome === 'flagged' ? 'high' : risk.riskLevel,
      factors: risk.factors,
      riskFactorCategories: risk.riskFactorCategories,
      v1RiskScore: risk.riskScore,
      fusionMode: 'v1',
      assessedAt: new Date(),
    };
    await product.save();

    // Promote user to seller role on first listing
    if (req.user.role === 'buyer') {
      await User.updateOne({ _id: req.user._id }, { role: 'seller' });
    }

    const populated = await Product.findById(product._id)
      .populate('category', 'name slug')
      .populate('seller', 'name avatar');

    res.status(201).json({
      success: true,
      product: populated,
      ...(identityStatus ? { identityStatus } : {}),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Download an image buffer from a URL. Uses the same fetch pattern as
 * reverifyImageAnalysis above.
 */
const fetchImageBuffer = async (url) => {
  if (!url || typeof url !== 'string') throw new Error('Image URL missing');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed with status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Clean up Cloudinary assets that are no longer needed (a rejected update
 * or a deleted listing). Only deletes publicIds not referenced by any
 * other listing so shared assets are never destroyed. Uses the existing
 * deleteFromCloudinary mechanism (safe no-op when Cloudinary is not
 * configured) and logs — never silently swallows — cleanup failures.
 */
const cleanupUnreferencedImages = async (publicIds, productId) => {
  for (const publicId of publicIds) {
    try {
      // 'removed' listings are soft-deleted — the document still exists but
      // is no longer a real reference, so its assets can be cleaned up.
      // Shared assets referenced by live listings are never destroyed.
      const referenced = await Product.exists({
        'images.publicId': publicId,
        _id: { $ne: productId },
        status: { $ne: 'removed' },
      });
      if (!referenced) await deleteFromCloudinary(publicId);
    } catch (err) {
      console.error('[Cloudinary] Cleanup failed for', publicId, '-', err.message);
    }
  }
};

/**
 * Re-run the fraud risk assessment for an edited listing and persist it. The
 * no-image PUT paths previously returned without re-scoring, so a category /
 * title / description / price edit was not reflected until the image worker
 * happened to run. Re-uses the persisted MobileNet prediction (stored on the
 * listing) so the category-agreement signal is re-evaluated against the new
 * category too. Best-effort: a scoring failure never blocks the edit response.
 */
const rerunRiskAssessment = async (product) => {
  try {
    const fresh = await Product.findById(product._id);
    if (!fresh) return;
    const categoryDoc = await Category.findById(fresh.category).select('name');
    const agreement = assessCategoryAgreement({
      predictedCategory: fresh.aiAnalysis?.classification?.predictedCategory,
      confidence: fresh.aiAnalysis?.classification?.confidence,
      chosenCategoryName: categoryDoc?.name,
    });
    const risk = await detectRisk({
      product: fresh,
      hashes: fresh.aiAnalysis?.imageHashes || [],
      aiAnalysis: fresh.aiAnalysis || {},
      categoryMismatch: agreement.mismatch,
    });
    if (!fresh.aiAnalysis) fresh.aiAnalysis = {};
    fresh.aiAnalysis.riskAssessment = {
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      factors: risk.factors,
      riskFactorCategories: risk.riskFactorCategories,
      assessedAt: new Date(),
    };
    await fresh.save();
  } catch (err) {
    console.warn(`[Product] Risk re-assessment failed for ${product._id}: ${err.message}`);
  }
};

/**
 * Enqueue a full image-worker re-analysis for an edited listing (best-effort:
 * a queue failure never blocks the edit response). Used when the category or
 * the primary object changes so the AI suggestion, category-agreement signal
 * and price/fraud refresh follow the edit. The worker preserves a
 * seller-chosen primaryObjectIndex across re-runs.
 */
const enqueueReanalysis = async (product) => {
  try {
    const { imageProcessingQueue } = require('../queues');
    await imageProcessingQueue.add('analyze-product', {
      productId: product._id.toString(),
      images: product.images.map((img) => ({
        url: img.url,
        publicId: img.publicId,
      })),
      productData: {
        title: product.title,
        description: product.description,
        price: product.price,
        originalPrice: product.originalPrice,
        category: product.category,
        brand: product.brand,
        model: product.model,
        condition: product.condition,
        yearsUsed: product.yearsUsed,
        specifications: product.specifications || [],
        location: product.location || {},
      },
    });
  } catch (err) {
    console.warn(`[Product] Could not enqueue re-analysis for ${product._id}: ${err.message}`);
  }
};

const updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');

    // Capture the ORIGINAL category before the allowed-fields loop below
    // mutates it — the edit-time duplicate check must be scoped to the
    // category the listing actually lives in, not the one this request is
    // moving it to.
    const originalCategory = product.category?.toString() || null;

    if (
      product.seller.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin'
    ) {
      throw new AppError('Not authorized to edit this listing', 403, 'FORBIDDEN');
    }

    const allowed = [
      'title',
      'description',
      'price',
      'originalPrice',
      'category',
      'brand',
      'model',
      'condition',
      'yearsUsed',
      'specifications',
      'location',
    ];
    // Which edits warrant an immediate re-score? Category/title/description/
    // price drive the fraud signals; other fields (brand, condition, …) do not.
    // A primary-object change re-points the AI suggestion at the chosen crop.
    const RISK_RELEVANT_FIELDS = ['category', 'title', 'description', 'price', 'originalPrice'];
    let riskRelevantChanged = false;
    let primaryObjectChanged = false;
    if (req.body.primaryObjectIndex !== undefined) {
      const idx = Number(req.body.primaryObjectIndex);
      const objects = Array.isArray(product.aiAnalysis?.detectedObjects)
        ? product.aiAnalysis.detectedObjects
        : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= objects.length) {
        throw new AppError(
          'Invalid primaryObjectIndex for this listing’s detected objects',
          400,
          'INVALID_PRIMARY_OBJECT'
        );
      }
      if (!product.aiAnalysis) product.aiAnalysis = {};
      product.aiAnalysis.primaryObjectIndex = idx;
      // Re-point the category suggestion + fingerprint at THAT crop's
      // embedding (README §7.12): the suggestion card, the category-agreement
      // signal and the visual fingerprint all read the primary crop.
      const chosen = objects[idx];
      product.aiAnalysis.classification = {
        predictedCategory: chosen.cropClassification || 'Other',
        confidence: typeof chosen.cropConfidence === 'number' ? chosen.cropConfidence : 0,
      };
      primaryObjectChanged = true;
      riskRelevantChanged = true;
    }
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      if (
        RISK_RELEVANT_FIELDS.includes(key) &&
        String(req.body[key] ?? '') !== String(product[key] ?? '')
      ) {
        riskRelevantChanged = true;
      }
      product[key] = req.body[key];
    }

    const incoming =
      req.body.images && Array.isArray(req.body.images) && req.body.images.length > 0
        ? req.body.images
        : null;

    if (!incoming) {
      // No image change — existing behavior
      await product.save();

      // A risk-relevant field edit (category/title/description/price) must be
      // reflected immediately, not only when the image worker next runs.
      if (riskRelevantChanged) {
        await rerunRiskAssessment(product);
      }

      // A category change re-runs the full AI pipeline through the worker so
      // the category suggestion, category-agreement signal and price/fraud
      // refresh follow the new category (applying the Sell-page AI suggestion
      // re-enqueues processing — it is never a local-only patch).
      if (primaryObjectChanged || req.body.category !== undefined) {
        await enqueueReanalysis(product);
      }

      const populated = await Product.findById(product._id)
        .populate('category', 'name slug')
        .populate('seller', 'name avatar');

      return res.json({ success: true, product: populated });
    }

    const keyOf = (img) => img.publicId || img.url;
    const currentKeys = new Set(product.images.map((i) => keyOf(i)).filter(Boolean));

    // The image set is "unchanged" when every incoming image is already on
    // the listing — edits that only touch other fields keep existing behavior.
    const imagesChanged =
      incoming.length !== product.images.length ||
      incoming.some((img) => !currentKeys.has(keyOf(img)));

    if (!imagesChanged) {
      product.images = incoming.map((img, idx) => ({
        url: img.url,
        publicId: img.publicId,
        isPrimary: idx === 0,
      }));
      await product.save();

      // A risk-relevant field edit (category/title/description/price) must be
      // reflected immediately, not only when the image worker next runs.
      if (riskRelevantChanged) {
        await rerunRiskAssessment(product);
      }

      // Same re-analysis guarantee as the no-image path above.
      if (primaryObjectChanged || req.body.category !== undefined) {
        await enqueueReanalysis(product);
      }

      const populated = await Product.findById(product._id)
        .populate('category', 'name slug')
        .populate('seller', 'name avatar');

      return res.json({ success: true, product: populated });
    }

    // ---- Edit-time image re-verification (same defenses as creation) ----
    // The product is NOT saved until every new image passes verification,
    // so a rejected edit can never leave a partially updated listing.
    const newPublicIds = [];
    const verified = [];

    try {
      for (const img of incoming) {
        const key = keyOf(img);
        const retained = currentKeys.has(key);
        let hash = null;
        let mirrorHash = null;
        let rotationHashes = [];
        let vflipHash = '';

        // Hashes are always computed server-side — client-submitted
        // hashes are never trusted.
        try {
          const buffer = await fetchImageBuffer(img.url);
          hash = await perceptualHashFromBuffer(buffer);
          mirrorHash = await mirrorPerceptualHashFromBuffer(buffer);
          const variants = await orientationHashesFromBuffer(buffer);
          rotationHashes = variants.rotationHashes;
          vflipHash = variants.vflipHash;
        } catch (err) {
          // Retained images may fall back to their stored hash; brand-new
          // images must be verifiable server-side or the edit is rejected.
          const stored = product.images.find((i) => keyOf(i) === key);
          if (retained && stored && stored.perceptualHash) {
            hash = stored.perceptualHash;
            mirrorHash = null;
            rotationHashes = [];
            vflipHash = '';
          } else {
            throw new AppError(
              'Could not verify one or more images. Images must be uploaded through ReSell.',
              400,
              'IMAGE_VERIFICATION_FAILED'
            );
          }
        }

        if (!retained && img.publicId) newPublicIds.push(img.publicId);
        verified.push({ img, hash, mirrorHash, rotationHashes, vflipHash, isNew: !retained });
      }

      // Duplicate detection for NEW images — identical rules to the
      // upload-time check: active/sold listings, hamming distance
      // <= DUPLICATE_HASH_THRESHOLD. Both the normal and the mirrored
      // hash are probed so a flipped copy of an existing image cannot
      // slip through. The scope covers BOTH the listing's original
      // category and any new category supplied in this request — a
      // seller can never scope the check away from the listing that
      // holds the original image by changing the category mid-edit.
      const requestedCategory = req.body.category !== undefined ? req.body.category : null;
      const scopeCategories = [
        ...new Set(
          [originalCategory, requestedCategory?.toString()].filter(Boolean)
        ),
      ];

      const candidates = [];
      for (const scopeCategory of scopeCategories) {
        const inScope = await Product.find({
          _id: { $ne: product._id },
          status: { $in: ['active', 'sold'] },
          'aiAnalysis.imageHashes': { $exists: true, $ne: [] },
          category: scopeCategory,
        })
          .select('title aiAnalysis.imageHashes aiAnalysis.rotationHashes aiAnalysis.vflipHash')
          .limit(500);
        candidates.push(...inScope);
      }

      for (const v of verified) {
        if (!v.isNew) continue;
        const probeSet = [v.hash, v.mirrorHash, ...(v.rotationHashes || []), v.vflipHash].filter(Boolean);
        for (const probe of probeSet) {
          if (!probe) continue;
          for (const candidate of candidates) {
            for (const candidateHash of collectHashSet(candidate.aiAnalysis)) {
              const distance = hammingDistance(probe, candidateHash);
              // null = non-pHash entry (e.g. sha256 fallback) — skip, never compare.
              if (distance !== null && distance <= DUPLICATE_HASH_THRESHOLD) {
                const similarityPct = Math.round((1 - distance / 64) * 100);
                throw new AppError(
                  `Duplicate image detected (~${similarityPct}% similar to existing listing "${candidate.title}"). This image is already used in another listing.`,
                  409,
                  'DUPLICATE_IMAGE'
                );
              }
            }
        }
      }
    }
    } catch (err) {
      // Verification failed — nothing was persisted. Clean up the newly
      // uploaded Cloudinary assets that belong to this rejected update.
      await cleanupUnreferencedImages(newPublicIds, product._id);
      throw err;
    }

    // Verification passed — apply the new image set with fresh hashes
    product.images = verified.map((v, idx) => ({
      url: v.img.url,
      publicId: v.img.publicId,
      isPrimary: idx === 0,
      perceptualHash: v.hash,
    }));
    if (!product.aiAnalysis) product.aiAnalysis = {};
    product.aiAnalysis.imageHashes = verified.flatMap((v) =>
      [v.hash, v.mirrorHash].filter(Boolean)
    );
    product.aiAnalysis.rotationHashes = verified
      .flatMap((v) => v.rotationHashes || [])
      .filter(Boolean);
    product.aiAnalysis.vflipHash = verified
      .flatMap((v) => (v.vflipHash ? [v.vflipHash] : []))
      .filter(Boolean);
    product.aiAnalysis.lastAnalyzedAt = new Date();

    await product.save();

    // Queue the full AI analysis re-run through the existing worker pipeline
    await imageProcessingQueue.add('analyze-product', {
      productId: product._id.toString(),
      images: verified.map((v) => ({
        url: v.img.url,
        publicId: v.img.publicId,
        hash: v.hash,
      })),
      productData: {
        title: product.title,
        description: product.description,
        price: product.price,
        originalPrice: product.originalPrice,
        category: product.category,
        brand: product.brand,
        model: product.model,
        condition: product.condition,
        yearsUsed: product.yearsUsed,
        specifications: product.specifications || [],
        location: product.location || {},
      },
    });

    // Recalculate the fraud/risk score with the verified hashes
    // (existing detectRisk service — same as listing creation)
    const risk = await detectRisk({
      product,
      hashes: product.aiAnalysis.imageHashes,
      aiAnalysis: product.aiAnalysis,
    });
    product.aiAnalysis.riskAssessment = {
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      factors: risk.factors,
      riskFactorCategories: risk.riskFactorCategories,
      v1RiskScore: risk.riskScore,
      fusionMode: 'v1',
      assessedAt: new Date(),
    };
    await product.save();

    const populated = await Product.findById(product._id)
      .populate('category', 'name slug')
      .populate('seller', 'name avatar');

    res.json({ success: true, product: populated });
  } catch (err) {
    next(err);
  }
};

const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');

    if (
      product.seller.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin'
    ) {
      throw new AppError('Not authorized to delete this listing', 403, 'FORBIDDEN');
    }

    // Delete images from Cloudinary — only assets not still referenced
    // by another listing; shared assets are never destroyed.
    await cleanupUnreferencedImages(
      product.images.map((img) => img.publicId).filter(Boolean),
      product._id
    );

    product.status = 'removed';
    await product.save();

    res.json({ success: true, message: 'Product removed' });
  } catch (err) {
    next(err);
  }
};

const markAsSold = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');
    if (product.seller.toString() !== req.user._id.toString()) {
      throw new AppError('Not authorized', 403, 'FORBIDDEN');
    }

    // Only active listings can be toggled sold (and sold listings relisted).
    // This prevents a seller from lifting a moderation hold via a
    // flagged -> sold -> active double-toggle, or from flipping a listing
    // that is locked in 'pending' by an open checkout session.
    if (product.status !== 'active' && product.status !== 'sold') {
      throw new AppError(
        `Cannot change sale status of a ${product.status} listing`,
        409,
        'INVALID_STATE'
      );
    }
    product.status = product.status === 'sold' ? 'active' : 'sold';
    await product.save();

    // Relisting restores the identity registry status (sold -> active) so
    // the identity matches the listing — otherwise the next edit/creation
    // would see a 'sold' identity for an active listing. Best-effort.
    if (product.status === 'active' && product.productIdentity) {
      await ProductIdentity.updateOne(
        { _id: product.productIdentity },
        { $set: { status: 'active' } }
      ).catch(() => {});
    }

    // Provenance event for tracked identities (server-side, best-effort)
    if (product.status === 'sold') {
      await recordSaleProvenance({
        productId: product._id.toString(),
        sellerId: req.user._id.toString(),
        eventType: 'sold',
      });
    }

    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
};

/**
 * Identity verification status for a product.
 *
 * Exposes only safe fields: identity status, verification info,
 * and provenance chain validity. Never exposes the raw identifier
 * or previous owners' private information.
 */
const getProductIdentityStatus = async (req, res, next) => {
  try {
    const identity = await ProductIdentity.findOne({ productId: req.params.id });
    if (!identity) {
      return res.json({ success: true, tracked: false });
    }

    const chain = await verifyProvenanceChain(identity._id);

    // Only the current owner may see the live verification code
    const isOwner =
      req.user && identity.currentOwnerId.toString() === req.user._id.toString();

    const possessionStatus = identity.verification?.possessionStatus || 'unverified';
    const signals =
      identity.status === 'reported_stolen'
        ? [SIGNALS.REPORTED_STOLEN_PRODUCT]
        : identity.status === 'flagged'
        ? [SIGNALS.PROVENANCE_INTEGRITY_FAILURE]
        : possessionStatus === 'failed'
        ? [SIGNALS.POSSESSION_VERIFICATION_FAILED]
        : [];
    const warnings =
      identity.status === 'reported_stolen'
        ? ['This product identifier has been reported as stolen.']
        : identity.status === 'flagged'
        ? ['This product identity is flagged and held for moderation.']
        : !chain.valid
        ? ['Provenance history for this product failed integrity verification.']
        : possessionStatus === 'failed'
        ? ['Proof-of-possession verification failed. Submit the correct code shown in your proof photo.']
        : [];

    res.json({
      success: true,
      tracked: true,
      identifierType: identity.identifierType,
      status: identity.status,
      verification: {
        verified: !!(identity.verification?.verifiedAt),
        method: identity.verification?.method || 'none',
        possessionStatus,
      },
      ...(isOwner
        ? {
            possession: {
              verificationCode: identity.verification?.verificationCode || '',
              codeExpiresAt: identity.verification?.codeExpiresAt || null,
              attempts: identity.verification?.attempts || 0,
            },
          }
        : {}),
      provenance: {
        valid: chain.valid,
        eventCount: chain.eventCount,
      },
      signals,
      warnings,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Proof-of-possession submission (seller only). The seller uploads a photo
 * of the physical product beside the short-lived verification code and
 * enters the code. Supporting fraud signal only — never proof of ownership,
 * and missing verification is never treated as fraud.
 */
const submitPossessionVerification = async (req, res, next) => {
  try {
    const { code, proofImageUrl } = req.body;
    const result = await verifyPossession({
      productId: req.params.id,
      sellerId: req.user._id,
      code,
      proofImageUrl,
    });
    res.json({ success: true, possessionStatus: result.possessionStatus, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * Request a possession-verification challenge (SCRUM-25, seller only).
 * Issues a fresh short-lived code the seller must show beside the physical
 * product in the proof photo. For listings without any identifier a
 * 'visual' possession identity is registered lazily — no sensitive
 * identifier required. The code is only ever returned to the current
 * owner; client-provided "verified" flags are never trusted.
 */
const requestPossession = async (req, res, next) => {
  try {
    const result = await requestPossessionChallenge({
      productId: req.params.id,
      sellerId: req.user._id,
    });

    if (result.alreadyVerified) {
      return res.json({
        success: true,
        alreadyVerified: true,
        possessionStatus: 'verified',
      });
    }

    res.json({
      success: true,
      ...(result.created ? { created: true } : {}),
      possessionStatus: result.identity.verification?.possessionStatus || 'unverified',
      possession: {
        verificationCode: result.identity.verification?.verificationCode || '',
        codeExpiresAt: result.identity.verification?.codeExpiresAt || null,
        attempts: result.identity.verification?.attempts || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};

const getMyProducts = async (req, res, next) => {
  try {
    const status = req.query.status;
    const filter = { seller: req.user._id };
    if (status) filter.status = status;
    else filter.status = { $ne: 'removed' };

    const items = await Product.find(filter)
      .populate('category', 'name slug')
      .sort({ createdAt: -1 });

    res.json({ success: true, items });
  } catch (err) {
    next(err);
  }
};

const getBrands = async (req, res, next) => {
  try {
    const brands = await Product.distinct('brand', { brand: { $ne: '' }, status: 'active' });
    res.json({ success: true, brands: brands.filter(Boolean).sort() });
  } catch (err) {
    next(err);
  }
};

const getSimilarProducts = async (req, res, next) => {
  try {
    const items = await findSimilar(req.params.id, 8);
    res.json({ success: true, items });
  } catch (err) {
    next(err);
  }
};

/**
 * Product reviews + a server-side eligibility hint for the requesting
 * user. The eligibility check is advisory for UI purposes only — review
 * creation always re-verifies the qualifying purchase server-side.
 */
const getProductReviews = async (req, res, next) => {
  try {
    const productId = req.params.id;

    const product = await Product.findById(productId);
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');

    const reviews = await Review.find({ product: productId })
      .populate('buyer', 'name avatar')
      .sort({ createdAt: -1 })
      .limit(50);

    const count = reviews.length;
    const average =
      count > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;

    let canReview = { allowed: false, reason: 'login_required' };
    if (req.user) {
      if (product.seller.toString() === req.user._id.toString()) {
        canReview = { allowed: false, reason: 'own_listing' };
      } else {
        const qualifyingSale = await Sale.findOne({
          buyer: req.user._id,
          product: productId,
          status: { $in: REVIEWABLE_STATUSES },
        });
        if (!qualifyingSale) {
          canReview = { allowed: false, reason: 'purchase_required' };
        } else if (await Review.exists({ sale: qualifyingSale._id })) {
          canReview = { allowed: false, reason: 'already_reviewed' };
        } else {
          canReview = { allowed: true };
        }
      }
    }

    res.json({
      success: true,
      reviews,
      summary: { count, average: Number(average.toFixed(2)) },
      canReview,
    });
  } catch (err) {
    next(err);
  }
};

const suggestPrice = async (req, res, next) => {
  try {
    const { category, condition, brand, originalPrice, yearsUsed, imageUrl } = req.query;

    // Build comparable listings query — active + sold in the same category
    const comparableFilter = { status: { $in: ['active', 'sold'] } };
    if (category) comparableFilter.category = category;

    const comparables = await Product.find(comparableFilter)
      .select('price condition brand originalPrice yearsUsed embedding createdAt')
      .sort({ createdAt: -1 })
      .limit(100);

    const result = await calculateRecommendedPrice({
      category,
      brand: brand || undefined,
      originalPrice: Number(originalPrice) || 0,
      yearsUsed: Number(yearsUsed) || 0,
      condition: condition || 'good',
      comparableListings: comparables,
    });

    let finalSuggested = result.recommendedPrice;
    let finalRange = { min: result.minPrice, max: result.maxPrice, p25: result.minPrice, p75: result.maxPrice };
    let finalConfidence = result.confidence;
    let finalSource = result.source;
    let finalExplanation = result.explanation;
    let finalFactors = result.factors;

    // Attempt ML microservice price estimation
    try {
      const mlClient = require('../services/mlClient');
      const mlResult = await mlClient.estimatePrice({
        listing: {
          category,
          condition: condition || 'good',
          brand: brand || '',
          originalPrice: Number(originalPrice) || 0,
          yearsUsed: Number(yearsUsed) || 0,
        },
        imageUrl: imageUrl || null,
        comparables: comparables.map((c) => ({
          id: c._id.toString(),
          price: c.price,
          originalPrice: c.originalPrice,
          condition: c.condition,
          category: c.category?.toString(),
          embedding: c.embedding || [],
        })),
      });

      if (mlResult && mlResult.suggestedPrice) {
        finalSuggested = mlResult.suggestedPrice;
        finalRange = mlResult.priceRange || finalRange;
        finalConfidence = mlResult.confidence || finalConfidence;
        finalSource = mlResult.source || 'ml-service';
        finalExplanation = mlResult.explanation || finalExplanation;
        finalFactors = mlResult.factors || finalFactors;
      }
    } catch (err) {
      console.warn('[SuggestPrice] ML estimation warning:', err.message);
    }

    res.json({
      success: true,
      suggestedPrice: finalSuggested,
      priceRange: finalRange,
      confidence: finalConfidence,
      comparableCount: comparables.length,
      explanation: finalExplanation,
      factors: finalFactors,
      source: finalSource,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProducts,
  getProduct,
  uploadImages,
  createProduct,
  updateProduct,
  deleteProduct,
  markAsSold,
  getMyProducts,
  getBrands,
  getSimilarProducts,
  getProductReviews,
  getProductIdentityStatus,
  submitPossessionVerification,
  requestPossession,
  suggestPrice,
};
