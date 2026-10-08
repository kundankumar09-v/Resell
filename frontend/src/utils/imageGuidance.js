// Multi-angle photo guidance (reusable). Category-specific shots are matched
// by slug/name keywords — mirrors the backend's identifier-eligibility
// keyword approach. Every category falls back to the generic guidance, so
// callers never need their own per-category logic.

const IMAGE_GUIDELINES = {
  phone: [
    'Front of the phone (screen on)',
    'Back of the phone',
    'Side / edge detail',
    'Camera module or IMEI area (optional)',
  ],
  laptop: [
    'Open screen',
    'Keyboard',
    'Back / underside',
    'Ports & connections (optional)',
  ],
  tablet: ['Front (screen on)', 'Back', 'Side / edge detail', 'Ports (optional)'],
  camera: ['Front of the camera', 'Back (screen)', 'Lens / mount detail', 'Condition detail (optional)'],
  shoes: ['Left side', 'Right side', 'Sole', 'Upper detail (optional)'],
  clothing: ['Front', 'Back', 'Label / tag', 'Condition detail (optional)'],
  watch: ['Dial / face', 'Case back', 'Strap / bracelet', 'Condition detail (optional)'],
  vehicle: ['Front exterior', 'Back exterior', 'Interior / dashboard', 'VIN / odometer area (optional)'],
  furniture: ['Full front view', 'Back view', 'Side / detail view', 'Condition detail (optional)'],
  book: ['Front cover', 'Back cover', 'Spine', 'Condition detail (optional)'],
};

const KEYWORDS = Object.keys(IMAGE_GUIDELINES);

const DEFAULT_GUIDELINES = [
  'Front / main view',
  'Back view',
  'Side / detail view',
  'Condition or serial area (optional)',
];

/**
 * Photo guidance for a category (name or slug). Returns the
 * category-specific list when a keyword matches, the generic list otherwise.
 */
export const imageGuidanceFor = (categoryName) => {
  const text = String(categoryName || '').toLowerCase();
  const hit = KEYWORDS.find((kw) => text.includes(kw));
  return IMAGE_GUIDELINES[hit] || DEFAULT_GUIDELINES;
};

// Requirement constants shared by the upload UI and validation
export const MIN_IMAGES = 3;
export const RECOMMENDED_IMAGES = '4-6';
export const MAX_IMAGES = 8;
