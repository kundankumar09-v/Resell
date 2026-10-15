const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      maxlength: [4000, 'Description cannot exceed 4000 characters'],
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    originalPrice: { type: Number, default: 0 },
    currencyCode: {
      type: String,
      default: 'USD',
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: [true, 'Category is required'],
    },
    brand: { type: String, default: '', trim: true },
    model: { type: String, default: '', trim: true },
    condition: {
      type: String,
      enum: ['new', 'like-new', 'good', 'fair', 'poor'],
      default: 'good',
    },
    yearsUsed: { type: Number, default: 0, min: 0 },
    specifications: [
      {
        key: String,
        value: String,
      },
    ],
    location: {
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      country: { type: String, default: '' },
    },
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, default: '' },
        isPrimary: { type: Boolean, default: false },
        // Per-image analysis
        perceptualHash: { type: String, default: '' },
        cnnFeatures: { type: [Number], default: [] }, // 1280D MobileNetV2 features
        colorHistogram: { type: [Number], default: [] }, // 48-bin color histogram
        productType: { type: String, default: 'unknown' },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
      },
    ],
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'sold', 'pending', 'rejected', 'removed', 'flagged', 'pendingReview'],
      default: 'active',
    },
    isFlagged: { type: Boolean, default: false },
    flagReason: { type: String, default: '' },

    // CLIP (ViT-B/32) 512-D visual embedding & ML evaluation
    embedding: { type: [Number], default: [] },
    fraudScore: { type: Number, default: 0, min: 0, max: 100 },
    fraudReasons: [{ type: String }],
    suggestedPrice: { type: Number, default: 0 },
    priceRange: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 0 },
      p25: { type: Number, default: 0 },
      p75: { type: Number, default: 0 },
    },

    // Physical-product identity (serial/IMEI/VIN registry entry)
    productIdentity: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductIdentity',
      default: null,
      index: true,
    },

    // Duplicate detection fields
    duplicateInfo: {
      isDuplicate: { type: Boolean, default: false, index: true },
      duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
      confidence: { type: Number, default: 0, min: 0, max: 1 },
      detectionMethod: { 
        type: String, 
        enum: ['perceptual_hash', 'perceptual_hash_exact', 'cnn_features', 'cnn_features_high_confidence', 'cnn_sift_combined', 'manual'],
        default: 'perceptual_hash' 
      },
      detectedAt: { type: Date, default: null },
      detectionDetails: {
        hammingDistance: { type: Number, default: null },
        cnnSimilarity: { type: Number, default: null },
        siftScore: { type: Number, default: null },
        stageTimings: {
          stage1_ms: { type: Number, default: 0 },
          stage2_ms: { type: Number, default: 0 },
          stage3_ms: { type: Number, default: 0 },
        },
        error: { type: String, default: '' },
      },
    },

    views: { type: Number, default: 0 },
    favoritesCount: { type: Number, default: 0 },

    // AI analysis fields (existing)
    aiAnalysis: {
      classification: {
        predictedCategory: { type: String, default: '' },
        confidence: { type: Number, default: 0 },
      },
      conditionScore: { type: Number, default: 0, min: 0, max: 100 },
      // 0/absent condition score means NO visual evidence; 30-100 is the
      // meaningful range (100 = like-new). confidence is the condition
      // estimate's own confidence (never the system-wide confidence).
      conditionConfidence: { type: Number, default: 0, min: 0, max: 1 },
      damageScore: { type: Number, default: 0, min: 0, max: 100 },
      // HIGHER damageScore means MORE damage. level: low / medium / high.
      // `null` must be a valid enum value — the `default: null` ("no visual
      // evidence") is applied on create and Mongoose validates defaults
      // against the enum, so excluding null would break every Product.create.
      damageLevel: { type: String, enum: ['low', 'medium', 'high', null], default: null },
      damageConfidence: { type: Number, default: 0, min: 0, max: 1 },
      // Whether the visual pipeline produced real evidence for the stored
      // condition/damage scores (false = insufficient evidence in the UI).
      visualAnalysisAvailable: { type: Boolean, default: false },
      damageDescription: { type: String, default: '' },
      // CLIP image↔title cosine similarity (README §7.9). null = not evaluated
      // (ML service down, or the title/image embedding was unavailable).
      imageTextSimilarity: { type: Number, default: null, min: -1, max: 1 },
      // Multi-object detections for the cover (first) image (README §7.12):
      // one entry per COCO-SSD box with its per-crop MobileNet classification
      // and local CNN embedding. Empty when nothing was detected or detection
      // failed — whole-image analysis then applies exactly as before.
      detectedObjects: [
        {
          bbox: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
            width: { type: Number, default: 0 },
            height: { type: Number, default: 0 },
          },
          label: { type: String, default: 'object' },
          score: { type: Number, default: 0, min: 0, max: 1 },
          cropClassification: { type: String, default: 'Other' },
          cropConfidence: { type: Number, default: 0, min: 0, max: 1 },
          cropEmbedding: { type: [Number], default: [] },
        },
      ],
      // Cover-image pixel dimensions the detectedObjects bboxes refer to
      // (frontend scales them to % for overlays).
      detectedImageWidth: { type: Number, default: 0 },
      detectedImageHeight: { type: Number, default: 0 },
      // True when the cover image holds >= 2 detected objects. The
      // highest-score crop (or the seller's primaryObjectIndex override)
      // drives the listing-level suggested category.
      multiObject: { type: Boolean, default: false },
      // Seller-chosen primary object (PUT primaryObjectIndex). Null = default
      // (highest detection score). Survives worker re-runs.
      primaryObjectIndex: { type: Number, default: null, min: 0 },
      // Informational note when >= 3 objects are detected (bundle photo).
      // Admin/owner-only display — stripped for other viewers in getProduct.
      bundleNote: { type: String, default: '' },
      imageHashes: [{ type: String }], // Legacy - keeping for backward compatibility
      // Rotation (90/180/270) and vertical-flip perceptual hashes extend the
      // flat imageHashes list (which carries normal + mirror entries) so
      // rotated / upside-down re-uploads are caught too. Stored side-by-side
      // in aiAnalysis; the fraud engine compares the full hash set.
      rotationHashes: [{ type: String }],
      vflipHash: [{ type: String }],
      // SCRUM-31: true when any stored hash came from the client echo rather
      // than a server-side upload record (legacy images) — the fraud engine
      // can weight unverified hashes accordingly.
      hashesUnverified: { type: Boolean, default: false },
      duplicateMatch: {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
        similarity: { type: Number, default: 0 },
      },
      priceRecommendation: {
        recommendedPrice: { type: Number, default: 0 },
        minPrice: { type: Number, default: 0 },
        maxPrice: { type: Number, default: 0 },
        confidence: { type: Number, default: 0 },
        explanation: { type: String, default: '' },
        factors: [{ type: String }],
        generatedAt: { type: Date, default: Date.now },
        refinedAt: { type: Date, default: null },
        refinementAttempts: { type: Number, default: 0 },
        source: {
          type: String,
          enum: ['ml-model', 'heuristic', 'ml-service', 'insufficient_data'],
          default: 'heuristic',
        },
      },
      riskAssessment: {
        riskScore: { type: Number, default: 0, min: 0, max: 100 },
        riskLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
        factors: [{ type: String }],
        // Generalized categories derived from the detailed factors. These are
        // what non-admin surfaces see — the exact factor strings (which expose
        // internal thresholds) stay admin-only.
        riskFactorCategories: [{ type: String }],
        // v1/v2 score fusion audit trail (see fuseFraudScores in
        // fraudDetection.js + README §8.4). Kept raw so the combination policy
        // can be re-evaluated without re-running either engine.
        v1RiskScore: { type: Number, default: null, min: 0, max: 100 },
        v2FraudProbability: { type: Number, default: null, min: 0, max: 1 },
        fusionMode: {
          type: String,
          enum: ['v1', 'v2', 'v1+v2-max'],
          default: 'v1',
        },
        // Categories a human moderator explicitly overruled (appeal approved).
        // Fed back to the ML pipeline as false-positive training signal and
        // shown to sellers as the disputed aspects of their listing.
        disputedFactors: [{ type: String }],
        assessedAt: { type: Date, default: Date.now },
      },
      lastAnalyzedAt: { type: Date, default: Date.now },
    },
  },
  { timestamps: true }
);

// Indexes for performance
productSchema.index({ title: 'text', description: 'text', brand: 'text', model: 'text' });
productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ price: 1 });
productSchema.index({ 'location.city': 1 });
productSchema.index({ seller: 1, status: 1 });
productSchema.index({ 'aiAnalysis.riskAssessment.riskScore': -1 });

// Duplicate detection indexes
productSchema.index({ 'duplicateInfo.isDuplicate': 1, status: 1 });
productSchema.index({ 'duplicateInfo.duplicateOf': 1 });
productSchema.index({ 'images.perceptualHash': 1, status: 1 });
productSchema.index({ 'images.cnnFeatures': 1 }); // For future vector search

// Compound indexes for common queries
productSchema.index({ category: 1, price: 1, status: 1 });
productSchema.index({ seller: 1, createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);