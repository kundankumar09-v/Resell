const crypto = require('crypto');

/**
 * 64-bit perceptual hash (pHash) using DCT (Discrete Cosine Transform).
 *
 * Algorithm:
 *   1. Resize to 32×32 grayscale
 *   2. Compute 2D DCT
 *   3. Take the top-left 8×8 block (lowest frequencies)
 *   4. Compute median of the 64 DCT coefficients
 *   5. Each bit = 1 if coefficient >= median, else 0
 *
 * This produces a 64-bit hash that is robust to:
 *   - Cropping, resizing, recompression
 *   - Minor color/brightness shifts
 *   - Different product photos of the same item
 *
 * Hamming distance thresholds for 64-bit pHash:
 *   0-8:  very likely duplicate
 *   9-12: possibly similar (manual review)
 *   13+:  different images
 */

const BLOCK_SIZE = 8;

const DCT_SIZE = 32;

// Precomputed cosine table: COS_TABLE[x][u] = cos((2x+1)·u·π / (2·N)).
// Avoids recomputing ~65k Math.cos calls for every 32×32 DCT.
const COS_TABLE = (() => {
  const table = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let x = 0; x < DCT_SIZE; x++) {
    for (let u = 0; u < DCT_SIZE; u++) {
      table[x * DCT_SIZE + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
    }
  }
  return table;
})();

function dct2d(input, width, height) {
  const temp = new Float64Array(width * height);
  const output = new Float64Array(width * height);

  // Fast path: the pHash pipeline always runs 32×32 — use the
  // precomputed table (identical values to the direct formula).
  const useTable = width === DCT_SIZE && height === DCT_SIZE;

  const cosXU = (x, u) =>
    useTable ? COS_TABLE[x * DCT_SIZE + u] : Math.cos(((2 * x + 1) * u * Math.PI) / (2 * width));
  const cosYV = (y, v) =>
    useTable ? COS_TABLE[y * DCT_SIZE + v] : Math.cos(((2 * y + 1) * v * Math.PI) / (2 * height));

  for (let y = 0; y < height; y++) {
    for (let u = 0; u < width; u++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += input[y * width + x] * cosXU(x, u);
      }
      temp[y * width + u] = sum;
    }
  }

  for (let u = 0; u < width; u++) {
    for (let v = 0; v < height; v++) {
      let sum = 0;
      for (let y = 0; y < height; y++) {
        sum += temp[y * width + u] * cosYV(y, v);
      }
      output[v * width + u] = sum;
    }
  }

  return output;
}

const perceptualHashFromBuffer = async (imageBuffer) => {
  try {
    let sharp;
    try {
      sharp = require('sharp');
    } catch {
      sharp = null;
    }

    if (sharp) {
      const { data } = await sharp(imageBuffer)
        .resize(32, 32, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const floatData = new Float64Array(32 * 32);
      for (let i = 0; i < 32 * 32; i++) {
        floatData[i] = data[i];
      }

      const dct = dct2d(floatData, 32, 32);

      const allCoeffs = [];
      for (let y = 0; y < BLOCK_SIZE; y++) {
        for (let x = 0; x < BLOCK_SIZE; x++) {
          allCoeffs.push(dct[y * 32 + x]);
        }
      }
      const allSorted = [...allCoeffs].sort((a, b) => a - b);
      const allMedian = allSorted[Math.floor(allSorted.length / 2)];

      const hashBits = allCoeffs.map((v) => (v >= allMedian ? 1 : 0)).join('');
      const hash = BigInt('0b' + hashBits).toString(16).padStart(16, '0');
      return hash;
    }

    return crypto.createHash('sha256').update(imageBuffer).digest('hex').slice(0, 16);
  } catch (err) {
    return crypto.createHash('sha256').update(imageBuffer).digest('hex').slice(0, 16);
  }
};

// A valid 64-bit pHash is 16 hex characters. sha256 fallback entries (64
// hex chars, written when sharp is unavailable) may also live in the
// stored flat hash lists — hamming distance over those is meaningless.
const PHASH_HEX_LENGTH = 16;

const hammingDistance = (hash1, hash2) => {
  // Missing operand: maximally distant (never matches) — pinned contract.
  if (!hash1 || !hash2) return 64;
  // SCRUM-32: non-pHash entries (e.g. sha256 fallback slices) and any
  // pair of differing length are excluded from hamming math. Returns
  // null so probe sites can skip the pair instead of comparing garbage.
  if (hash1.length !== PHASH_HEX_LENGTH || hash2.length !== PHASH_HEX_LENGTH) return null;
  let distance = 0;
  const bin1 = BigInt('0x' + hash1).toString(2).padStart(64, '0');
  const bin2 = BigInt('0x' + hash2).toString(2).padStart(64, '0');
  for (let i = 0; i < bin1.length; i++) {
    if (bin1[i] !== bin2[i]) distance++;
  }
  return distance;
};

const similarity = (hash1, hash2) => {
  const distance = hammingDistance(hash1, hash2);
  if (distance === null) return 0;
  return Math.max(0, 1 - distance / 64);
};

/**
 * Perceptual hash of the horizontally flipped (mirrored) image.
 *
 * Fraudsters mirror a stolen image to evade pHash detection — the DCT
 * hash of a flipped image differs by a large hamming distance (observed
 * ~53 on real test images), so the plain hash never matches. Hashing the
 * flopped variant as well lets duplicate checks catch mirrored copies:
 * a mirrored upload's own hash matches the original's mirror hash.
 *
 * Falls back to the normal hash when sharp is unavailable (no extra
 * false positives, just no mirror coverage).
 */
const mirrorPerceptualHashFromBuffer = async (imageBuffer) => {
  try {
    let sharp;
    try {
      sharp = require('sharp');
    } catch {
      sharp = null;
    }

    if (!sharp) {
      return perceptualHashFromBuffer(imageBuffer);
    }

    const flopped = await sharp(imageBuffer).flop().png().toBuffer();
    return perceptualHashFromBuffer(flopped);
  } catch (err) {
    return perceptualHashFromBuffer(imageBuffer);
  }
};

/**
 * Perceptual hash of the image rotated `degrees` clockwise (90/180/270).
 *
 * Simple image transformations defeat the plain DCT hash — a rotated copy
 * of an item photo has a very different hash from the original. Hashing the
 * rotated variants as well lets duplicate checks catch 90°/180°/270° rotated
 * re-uploads: an upload's own rotated hash matches the original's stored
 * rotation hash for the same angle.
 *
 * Falls back to the plain hash when sharp is unavailable (no extra false
 * positives, just no rotation coverage) — same contract as the mirror hash.
 */
const rotatePerceptualHashFromBuffer = async (imageBuffer, degrees = 90) => {
  try {
    let sharp;
    try {
      sharp = require('sharp');
    } catch {
      sharp = null;
    }

    if (!sharp) {
      return perceptualHashFromBuffer(imageBuffer);
    }

    const rotated = await sharp(imageBuffer).rotate(degrees).png().toBuffer();
    return perceptualHashFromBuffer(rotated);
  } catch (err) {
    return perceptualHashFromBuffer(imageBuffer);
  }
};

/**
 * Perceptual hash of the vertically flipped image (upside-down).
 *
 * Mirrors the horizontal mirror hash: a vertically flipped copy evades the
 * plain pHash, so the flipped variant is hashed alongside the original so
 * duplicate checks can catch it. sharp.flip() = vertical axis (flop() is
 * the horizontal mirror covered by mirrorPerceptualHashFromBuffer).
 *
 * Falls back to the plain hash when sharp is unavailable.
 */
const verticalFlipPerceptualHashFromBuffer = async (imageBuffer) => {
  try {
    let sharp;
    try {
      sharp = require('sharp');
    } catch {
      sharp = null;
    }

    if (!sharp) {
      return perceptualHashFromBuffer(imageBuffer);
    }

    const flipped = await sharp(imageBuffer).flip().png().toBuffer();
    return perceptualHashFromBuffer(flipped);
  } catch (err) {
    return perceptualHashFromBuffer(imageBuffer);
  }
};

/**
 * Compute the full orientation hash set for an image in one call:
 * plain, mirror, rotate90, rotate180, rotate270, vertical-flip.
 * Returns { rotationHashes: [r90, r180, r270], vflipHash } (vflipHash is a
 * string; callers aggregate per-image vflips into arrays on the product).
 */
const orientationHashesFromBuffer = async (imageBuffer) => {
  const [r90, r180, r270, vflipHash] = await Promise.all([
    rotatePerceptualHashFromBuffer(imageBuffer, 90),
    rotatePerceptualHashFromBuffer(imageBuffer, 180),
    rotatePerceptualHashFromBuffer(imageBuffer, 270),
    verticalFlipPerceptualHashFromBuffer(imageBuffer),
  ]);
  return { rotationHashes: [r90, r180, r270], vflipHash };
};

module.exports = {
  perceptualHashFromBuffer,
  mirrorPerceptualHashFromBuffer,
  rotatePerceptualHashFromBuffer,
  verticalFlipPerceptualHashFromBuffer,
  orientationHashesFromBuffer,
  hammingDistance,
  similarity,
};
