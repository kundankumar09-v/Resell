const mongoose = require('mongoose');

/**
 * ImageUploadRecord (SCRUM-31) — server-side hash authority for uploads.
 *
 * The upload-images endpoint computes hash/mirrorHash from the raw image
 * bytes. The client merely echoes that response back to createProduct,
 * which previously meant a crafted API call could omit or fabricate
 * hashes and silently bypass duplicate detection and risk flagging.
 *
 * This record persists the computed hashes at upload time, keyed by
 * (user, publicId). createProduct reads them back instead of trusting
 * the client echo. Records expire after 30 days (listings are normally
 * created within minutes of upload); anything without a record follows
 * the legacy echo path, flagged via aiAnalysis.hashesUnverified.
 */
const imageUploadRecordSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    publicId: { type: String, required: true },
    url: { type: String, default: '' },
    hash: { type: String, default: null },
    mirrorHash: { type: String, default: null },
    // Rotation (90/180/270) and vertical-flip hashes computed at upload time —
    // persisted server-side so createProduct never trusts client echo for these.
    rotationHashes: { type: [String], default: [] },
    vflipHash: { type: String, default: null },
  },
  { timestamps: true }
);

imageUploadRecordSchema.index({ user: 1, publicId: 1 }, { unique: true });
imageUploadRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model('ImageUploadRecord', imageUploadRecordSchema);
