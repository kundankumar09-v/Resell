/**
 * Image Classification Service using MobileNet (TensorFlow.js).
 *
 * Uses a pre-trained MobileNet model to classify product images into
 * the ReSell category taxonomy. Image decoding uses `sharp` (already
 * a project dependency) to convert buffers to raw pixel tensors.
 *
 * Falls back to keyword-based classification if TF.js/MobileNet
 * fails to load or if classification confidence is too low.
 */

let tf;
let mobilenet;
let cocoSsd;
let modelLoaded = false;
let loadPromise = null;
let detectorLoaded = false;
let detectorLoadPromise = null;

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

try {
  tf = require('@tensorflow/tfjs');
  mobilenet = require('@tensorflow-models/mobilenet');
  cocoSsd = require('@tensorflow-models/coco-ssd');
} catch {
  tf = null;
  mobilenet = null;
  cocoSsd = null;
}

/**
 * Mapping from MobileNet ImageNet labels to ReSell category taxonomy.
 * Keys are lowercase substrings that match MobileNet's className output.
 */
const IMAGENET_TO_CATEGORY = {
  // Electronics
  'cellular telephone': 'Electronics',
  'cellphone': 'Electronics',
  'mobile phone': 'Electronics',
  'notebook': 'Electronics',
  'laptop': 'Electronics',
  'desktop computer': 'Electronics',
  'monitor': 'Electronics',
  'television': 'Electronics',
  'screen': 'Electronics',
  'ipod': 'Electronics',
  'digital camera': 'Electronics',
  'camera': 'Electronics',
  'webcam': 'Electronics',
  'headphone': 'Electronics',
  'earphone': 'Electronics',
  'loudspeaker': 'Electronics',
  'speaker': 'Electronics',
  'printer': 'Electronics',
  'projector': 'Electronics',
  'game controller': 'Electronics',
  'joystick': 'Electronics',
  'remote control': 'Electronics',
  'mouse': 'Electronics',
  'computer keyboard': 'Electronics',

  // Fashion
  'shirt': 'Fashion',
  'polo shirt': 'Fashion',
  't-shirt': 'Fashion',
  'sweater': 'Fashion',
  'jacket': 'Fashion',
  'coat': 'Fashion',
  'dress': 'Fashion',
  'skirt': 'Fashion',
  'trousers': 'Fashion',
  'jean': 'Fashion',
  'sandal': 'Fashion',
  'shoe': 'Fashion',
  'running shoe': 'Fashion',
  'sneaker': 'Fashion',
  'boot': 'Fashion',
  'sunglasses': 'Fashion',
  'goggles': 'Fashion',
  'watch': 'Fashion',
  'wristlet': 'Fashion',
  'handbag': 'Fashion',
  'purse': 'Fashion',
  'wallet': 'Fashion',
  'backpack': 'Fashion',
  'suitcase': 'Fashion',
  'hat': 'Fashion',
  'beanie': 'Fashion',
  'scarf': 'Fashion',
  'necklace': 'Fashion',
  'ring': 'Fashion',
  'belt': 'Fashion',
  'tie': 'Fashion',
  'cardigan': 'Fashion',
  'jersey': 'Fashion',
  'raincoat': 'Fashion',
  'fur coat': 'Fashion',
  'brassiere': 'Fashion',

  // Home & Garden
  'table lamp': 'Home & Garden',
  'lampshade': 'Home & Garden',
  'chair': 'Home & Garden',
  'rocking chair': 'Home & Garden',
  'sofa': 'Home & Garden',
  'studio couch': 'Home & Garden',
  'table': 'Home & Garden',
  'desk': 'Home & Garden',
  'bookcase': 'Home & Garden',
  'shelf': 'Home & Garden',
  'bed': 'Home & Garden',
  'crib': 'Home & Garden',
  'wardrobe': 'Home & Garden',
  'dresser': 'Home & Garden',
  'coffee table': 'Home & Garden',
  'dining table': 'Home & Garden',
  'vacuum cleaner': 'Home & Garden',
  'microwave oven': 'Home & Garden',
  'toaster': 'Home & Garden',
  'coffee maker': 'Home & Garden',
  'blender': 'Home & Garden',
  'refrigerator': 'Home & Garden',
  'dishwasher': 'Home & Garden',
  'washing machine': 'Home & Garden',
  'clothes dryer': 'Home & Garden',
  'iron': 'Home & Garden',
  'fan': 'Home & Garden',
  'air conditioner': 'Home & Garden',
  'heater': 'Home & Garden',

  // Sports & Outdoors
  'bicycle': 'Sports & Outdoors',
  'motor scooter': 'Sports & Outdoors',
  'barbell': 'Sports & Outdoors',
  'dumbbell': 'Sports & Outdoors',
  'treadmill': 'Sports & Outdoors',
  'tennis racket': 'Sports & Outdoors',
  'baseball bat': 'Sports & Outdoors',
  'baseball glove': 'Sports & Outdoors',
  'football': 'Sports & Outdoors',
  'basketball': 'Sports & Outdoors',
  'soccer ball': 'Sports & Outdoors',
  'golf club': 'Sports & Outdoors',
  'ski': 'Sports & Outdoors',
  'surfboard': 'Sports & Outdoors',
  'kayak': 'Sports & Outdoors',
  'tent': 'Sports & Outdoors',
  'sleeping bag': 'Sports & Outdoors',
  'helmet': 'Sports & Outdoors',
  'skateboard': 'Sports & Outdoors',

  // Books & Media
  'book': 'Books & Media',
  'textbook': 'Books & Media',
  'comic book': 'Books & Media',
  'magazine': 'Books & Media',
  'newspaper': 'Books & Media',
  'vinyl record': 'Books & Media',

  // Toys & Games
  'toy': 'Toys & Games',
  'doll': 'Toys & Games',
  'teddy bear': 'Toys & Games',
  'puzzle': 'Toys & Games',
  'board game': 'Toys & Games',
  'jigsaw puzzle': 'Toys & Games',
  'lego': 'Toys & Games',
  'rubik': 'Toys & Games',

  // Beauty & Health
  'perfume': 'Beauty & Health',
  'cosmetics': 'Beauty & Health',
  'lipstick': 'Beauty & Health',
  'hair dryer': 'Beauty & Health',

  // Automotive
  'car': 'Automotive',
  'jeep': 'Automotive',
  'truck': 'Automotive',
  'motorcycle': 'Automotive',
  'wheel': 'Automotive',
  'tire': 'Automotive',
};

/** Confidence threshold below which we don't auto-fill category. */
const CONFIDENCE_THRESHOLD = 0.15;

// ── Multi-object detection (COCO-SSD) ─────────────────────────────────────
// Env-configurable thresholds following the fraud-detection convention:
//   OBJECT_DETECTION_MIN_SCORE    — boxes below this are dropped (default 0.5)
//   OBJECT_DETECTION_IOU_THRESHOLD — overlaps above this keep only the best (default 0.6)
//   OBJECT_DETECTION_MAX_OBJECTS  — per-image crop cap bounding MobileNet cost (default 8)
//   OBJECT_DETECTION_CROP_PADDING  — padding around each box, fraction per side (default 0.10)
//   OBJECT_DETECTION_MAX_DIM       — detection input capped to this long edge (default 800);
//                                    boxes are scaled back to original pixels for crops/overlays.
const envNum = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const OBJECT_DETECTION_MIN_SCORE = envNum('OBJECT_DETECTION_MIN_SCORE', 0.5);
const OBJECT_DETECTION_IOU_THRESHOLD = envNum('OBJECT_DETECTION_IOU_THRESHOLD', 0.6);
const OBJECT_DETECTION_MAX_OBJECTS = Math.max(1, Math.floor(envNum('OBJECT_DETECTION_MAX_OBJECTS', 8)));
const OBJECT_DETECTION_CROP_PADDING = envNum('OBJECT_DETECTION_CROP_PADDING', 0.1);
const OBJECT_DETECTION_MAX_DIM = Math.max(224, Math.floor(envNum('OBJECT_DETECTION_MAX_DIM', 800)));

let model = null;
let detector = null;

/**
 * Load the COCO-SSD object detector (lazy, once, alongside MobileNet).
 * Returns null (never throws) when TF.js/coco-ssd/sharp is unavailable —
 * callers fall back to whole-image analysis.
 */
const loadDetector = async () => {
  if (detectorLoaded && detector) return detector;
  if (detectorLoadPromise) return detectorLoadPromise;

  if (!tf || !cocoSsd || !sharp) {
    return null;
  }

  detectorLoadPromise = (async () => {
    try {
      console.log('[ImageClassifier] Loading COCO-SSD model...');
      detector = await cocoSsd.load({ base: 'mobilenet_v2' });
      detectorLoaded = true;
      console.log('[ImageClassifier] COCO-SSD loaded');
      return detector;
    } catch (err) {
      console.error('[ImageClassifier] Failed to load COCO-SSD:', err.message);
      detectorLoadPromise = null;
      return null;
    }
  })();

  return detectorLoadPromise;
};

/**
 * Intersection-over-union of two [x, y, width, height] boxes.
 */
const boxIoU = (a, b) => {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter === 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
};

/**
 * Greedy non-maximum suppression: highest score first, drop boxes whose IoU
 * with a kept box exceeds OBJECT_DETECTION_IOU_THRESHOLD.
 */
const deduplicateDetections = (detections) => {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const det of sorted) {
    if (kept.some((k) => boxIoU(k.bbox, det.bbox) > OBJECT_DETECTION_IOU_THRESHOLD)) continue;
    kept.push(det);
    if (kept.length >= OBJECT_DETECTION_MAX_OBJECTS) break;
  }
  return kept;
};

/**
 * Run COCO-SSD detection on an image buffer.
 *
 * Decodes via sharp (capped at OBJECT_DETECTION_MAX_DIM for speed), runs
 * detect(), keeps boxes with score >= OBJECT_DETECTION_MIN_SCORE and
 * deduplicates overlaps (IoU > threshold keeps the highest score). Box
 * coordinates are scaled back to ORIGINAL image pixels so they can drive
 * sharp crops and frontend overlays directly.
 *
 * Never throws: detection failure returns { available: false, reason } and
 * callers fall back to whole-image analysis exactly as before.
 *
 * @returns {Promise<{ available: boolean, reason?: string, objects?: Array<{bbox, label, score}>, imageWidth?, imageHeight? }>}
 */
const detectObjects = async (imageBuffer) => {
  const d = await loadDetector();

  if (!d) {
    return { available: false, reason: 'detector_unavailable' };
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return { available: false, reason: 'no-buffer' };
  }

  let tensor = null;
  try {
    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width || 0;
    const origH = meta.height || 0;
    if (!origW || !origH) {
      return { available: false, reason: 'unreadable-image' };
    }

    const scale = Math.min(1, OBJECT_DETECTION_MAX_DIM / Math.max(origW, origH));
    const detW = Math.max(1, Math.round(origW * scale));
    const detH = Math.max(1, Math.round(origH * scale));

    const { data } = await sharp(imageBuffer)
      .resize(detW, detH, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    tensor = tf.tensor3d(new Float32Array(data), [detH, detW, 3], 'float32');
    const predictions = await d.detect(tensor);

    const objects = (Array.isArray(predictions) ? predictions : [])
      .filter((p) => p && typeof p.score === 'number' && p.score >= OBJECT_DETECTION_MIN_SCORE)
      .map((p) => {
        const [x, y, w, h] = p.bbox;
        return {
          // Back to original pixels (clamped, integer).
          bbox: [
            Math.max(0, Math.round(x / scale)),
            Math.max(0, Math.round(y / scale)),
            Math.max(1, Math.round(w / scale)),
            Math.max(1, Math.round(h / scale)),
          ],
          label: p.class || 'object',
          score: Number(p.score.toFixed(3)),
        };
      });

    return {
      available: true,
      objects: deduplicateDetections(objects),
      imageWidth: origW,
      imageHeight: origH,
    };
  } catch (err) {
    console.warn('[ImageClassifier] Object detection failed, falling back to whole-image analysis:', err.message);
    return { available: false, reason: 'detection_error' };
  } finally {
    if (tensor) {
      try { tensor.dispose(); } catch { /* already disposed */ }
    }
  }
};

/**
 * Crop a detection box from the original buffer with OBJECT_DETECTION_CROP_PADDING
 * padding per side, clamped to the image bounds. Returns null when the crop
 * fails — the object is skipped, never the whole listing.
 */
const cropDetection = async (imageBuffer, bbox) => {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const imgW = meta.width || 0;
    const imgH = meta.height || 0;
    if (!imgW || !imgH) return null;

    const [x, y, w, h] = bbox;
    const padX = Math.round(w * OBJECT_DETECTION_CROP_PADDING);
    const padY = Math.round(h * OBJECT_DETECTION_CROP_PADDING);
    const left = Math.max(0, x - padX);
    const top = Math.max(0, y - padY);
    const width = Math.min(imgW - left, w + padX * 2);
    const height = Math.min(imgH - top, h + padY * 2);
    if (width < 1 || height < 1) return null;

    return await sharp(imageBuffer).extract({ left, top, width, height }).toBuffer();
  } catch {
    return null;
  }
};

/**
 * Local CNN embedding of an image buffer via MobileNet's intermediate layer
 * (model.infer). Same-space for every crop, so crop-vs-crop cosine comparison
 * is meaningful. Returns null on any failure — never throws.
 */
const embedBuffer = async (buffer) => {
  const m = await loadModel();
  if (!m || typeof m.infer !== 'function' || !buffer) return null;
  let tensor = null;
  let embedding = null;
  try {
    const { data } = await sharp(buffer)
      .resize(224, 224, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    tensor = tf.tensor3d(new Float32Array(data), [224, 224, 3], 'float32');
    embedding = m.infer(tensor, true);
    const values = Array.isArray(embedding) ? embedding : embedding.arraySync();
    const flat = Array.isArray(values[0]) ? values[0] : values;
    return flat.map((v) => Number(v));
  } catch {
    return null;
  } finally {
    if (tensor) {
      try { tensor.dispose(); } catch { /* already disposed */ }
    }
    if (embedding && typeof embedding.dispose === 'function') {
      try { embedding.dispose(); } catch { /* already disposed */ }
    }
  }
};

/**
 * Full per-image multi-object analysis: detect → crop each box → per-crop
 * MobileNet classification + CNN embedding.
 *
 * Returns { objects: [{ bbox, label, score, cropClassification,
 * cropConfidence, cropEmbedding }] } — objects is empty (not an error) when
 * nothing was detected or detection failed, in which case callers use the
 * whole-image analysis fallback exactly as today. Never throws and never
 * blocks listing creation.
 */
const analyzeDetectedObjects = async (imageBuffer, metadata = {}) => {
  try {
    const detection = await detectObjects(imageBuffer);
    if (!detection.available || !detection.objects || detection.objects.length === 0) {
      return { objects: [], imageWidth: detection.imageWidth || 0, imageHeight: detection.imageHeight || 0 };
    }

    const objects = [];
    for (const det of detection.objects) {
      const crop = await cropDetection(imageBuffer, det.bbox);
      if (!crop) continue;
      const [classification, cropEmbedding] = await Promise.all([
        classifyImage(crop, metadata),
        embedBuffer(crop),
      ]);
      objects.push({
        bbox: { x: det.bbox[0], y: det.bbox[1], width: det.bbox[2], height: det.bbox[3] },
        label: det.label,
        score: det.score,
        cropClassification: classification?.category || 'Other',
        cropConfidence: typeof classification?.confidence === 'number' ? classification.confidence : 0,
        cropEmbedding: Array.isArray(cropEmbedding) ? cropEmbedding : [],
      });
    }

    return { objects, imageWidth: detection.imageWidth, imageHeight: detection.imageHeight };
  } catch (err) {
    console.warn('[ImageClassifier] Multi-object analysis failed, falling back to whole-image analysis:', err.message);
    return { objects: [], imageWidth: 0, imageHeight: 0 };
  }
};
/**
 * Load the MobileNet model (lazy, once).
 */
const loadModel = async () => {
  if (modelLoaded && model) return model;
  if (loadPromise) return loadPromise;

  if (!tf || !mobilenet || !sharp) {
    return null;
  }

  loadPromise = (async () => {
    try {
      console.log('[ImageClassifier] Loading MobileNet model...');
      model = await mobilenet.load({ version: 2, alpha: 1.0 });
      modelLoaded = true;
      console.log('[ImageClassifier] MobileNet loaded');
      return model;
    } catch (err) {
      console.error('[ImageClassifier] Failed to load MobileNet:', err.message);
      loadPromise = null;
      return null;
    }
  })();

  return loadPromise;
};

/**
 * Classify an image buffer using MobileNet + sharp for decoding.
 *
 * 1. Decode the image buffer via sharp → raw RGB pixels at 224×224
 * 2. Convert to a Float32 tensor (normalized 0-1)
 * 3. Run MobileNet inference
 * 4. Map top predictions to ReSell categories
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{category: string, confidence: number, topLabels: Array, source: string}>}
 */
const classifyImage = async (imageBuffer) => {
  const m = await loadModel();

  if (!m) {
    return { category: 'Other', confidence: 0, topLabels: [], source: 'unavailable' };
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return { category: 'Other', confidence: 0, topLabels: [], source: 'no-buffer' };
  }

  let tensor = null;
  try {
    // Decode image buffer via sharp → 224x224 RGB raw pixels
    const { data, info } = await sharp(imageBuffer)
      .resize(224, 224, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Pass raw 0-255 pixels as a 3D float tensor [224, 224, 3].
    // @tensorflow-models/mobilenet@2.1.1 normalizes internally (inputRange
    // [0,1] over raw 0-255 input), so pre-dividing by 255 here collapses the
    // effective input to near-black and yields near-uniform predictions.
    // The 3D shape also skips mobilenet's redundant resizeBilinear path.
    tensor = tf.tensor3d(new Float32Array(data), [224, 224, 3], 'float32');

    // Classify
    const predictions = await m.classify(tensor, 10);

    // Map ImageNet labels → ReSell categories
    const categoryScores = {};
    const topLabels = [];

    for (const pred of predictions) {
      const label = pred.className.toLowerCase();
      const prob = pred.probability;

      topLabels.push({ label: pred.className, probability: prob });

      for (const [imagenetLabel, resellCategory] of Object.entries(IMAGENET_TO_CATEGORY)) {
        if (label.includes(imagenetLabel)) {
          if (!categoryScores[resellCategory]) categoryScores[resellCategory] = 0;
          categoryScores[resellCategory] += prob;
        }
      }
    }

    let bestCategory = 'Other';
    let bestScore = 0;
    for (const [category, score] of Object.entries(categoryScores)) {
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    const confidence = bestScore > 0 ? Math.min(0.95, bestScore) : 0;

    return {
      category: bestCategory,
      confidence: Number(confidence.toFixed(2)),
      topLabels,
      source: 'mobilenet',
    };
  } catch (err) {
    console.error('[ImageClassifier] Classification failed:', err.message);
    return { category: 'Other', confidence: 0, topLabels: [], source: 'error' };
  } finally {
    if (tensor) tensor.dispose();
  }
};

module.exports = {
  classifyImage,
  loadModel,
  loadDetector,
  detectObjects,
  deduplicateDetections,
  boxIoU,
  cropDetection,
  analyzeDetectedObjects,
  IMAGENET_TO_CATEGORY,
  CONFIDENCE_THRESHOLD,
  OBJECT_DETECTION_MIN_SCORE,
  OBJECT_DETECTION_IOU_THRESHOLD,
  OBJECT_DETECTION_MAX_OBJECTS,
  OBJECT_DETECTION_CROP_PADDING,
};
