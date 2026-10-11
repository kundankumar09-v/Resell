const Product = require('../models/Product');
const Appeal = require('../models/Appeal');
const AppError = require('../utils/AppError');
const { notify } = require('../services/notificationService');
const { sendOutcomeFeedback } = require('../services/mlClient');

/**
 * Seller appeals an automated fraud/quality flag on one of their listings.
 * Only the listing owner may appeal, and only while the listing is still
 * flagged. One open appeal per product at a time.
 */
const createAppeal = async (req, res, next) => {
  try {
    const { reason } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');
    if (String(product.seller) !== String(req.user._id)) {
      throw new AppError('You can only appeal your own listings', 403, 'FORBIDDEN');
    }
    if (!product.isFlagged) {
      throw new AppError('This listing is not currently flagged', 409, 'NOT_FLAGGED');
    }

    const open = await Appeal.findOne({ product: product._id, status: 'pending' });
    if (open) {
      throw new AppError('An appeal for this listing is already under review', 409, 'APPEAL_EXISTS');
    }

    const appeal = await Appeal.create({
      product: product._id,
      seller: req.user._id,
      reason,
    });

    res.status(201).json({ success: true, appeal });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin list of appeals (filterable by status).
 */
const listAppeals = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Appeal.find(filter)
        .populate('product', 'title images price isFlagged status flagReason')
        .populate('seller', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Appeal.countDocuments(filter),
    ]);

    res.json({
      success: true,
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin decides an appeal. Approving clears the automated flag; rejecting
 * keeps it. Either way the decision is recorded for the feedback loop.
 */
const decideAppeal = async (req, res, next) => {
  try {
    const { status, moderatorNote } = req.body;

    const appeal = await Appeal.findById(req.params.id).populate('product');
    if (!appeal) throw new AppError('Appeal not found', 404, 'NOT_FOUND');
    if (appeal.status !== 'pending') {
      throw new AppError('This appeal has already been decided', 409, 'ALREADY_DECIDED');
    }

    appeal.status = status;
    appeal.moderatorNote = moderatorNote || '';
    appeal.decidedBy = req.user._id;
    appeal.decidedAt = new Date();
    await appeal.save();

    if (status === 'approved' && appeal.product) {
      await Product.findByIdAndUpdate(appeal.product._id, {
        isFlagged: false,
        flagReason: '',
      });

      // Record the disputed categories and send a false-positive outcome to
      // the ML pipeline. Best-effort: unknown/disputed categories are handled
      // by the schema default and the feedback helper never throws.
      const product = await Product.findById(appeal.product._id);
      if (product?.aiAnalysis) {
        const assessment = product.aiAnalysis.riskAssessment;
        const categories = assessment?.riskFactorCategories || [];
        const existing = new Set(assessment?.disputedFactors || []);
        const disputed = categories.filter((cat) => !existing.has(cat));
        if (disputed.length > 0) {
          assessment.disputedFactors = [...existing, ...disputed];
          await product.save();
        }
        await sendOutcomeFeedback({
          recordId: appeal.product._id,
          outcome: {
            decided: 'false_positive',
            factorCategories: categories,
            disputedFactors: disputed,
          },
        });
      }
    }

    await notify({
      recipient: appeal.seller,
      type: 'appeal_decision',
      payload: {
        productId: appeal.product._id,
        appealId: appeal._id,
        metadata: { status, moderatorNote: appeal.moderatorNote },
      },
    });

    res.json({ success: true, appeal });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createAppeal,
  listAppeals,
  decideAppeal,
};