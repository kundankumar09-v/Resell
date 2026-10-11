const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['message', 'offer', 'order', 'report_update', 'admin_action', 'appeal_decision'],
      required: true,
    },
    payload: {
      conversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
      offerId: { type: mongoose.Schema.Types.ObjectId, default: null },
      productId: { type: mongoose.Schema.Types.ObjectId, default: null },
      saleId: { type: mongoose.Schema.Types.ObjectId, default: null },
      reportId: { type: mongoose.Schema.Types.ObjectId, default: null },
      senderId: { type: mongoose.Schema.Types.ObjectId, default: null },
      appealId: { type: mongoose.Schema.Types.ObjectId, default: null },
      metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
