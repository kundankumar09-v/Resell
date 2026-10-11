const Report = require('../models/Report');
const Product = require('../models/Product');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const audit = require('../middleware/audit');
const { notify } = require('../services/notificationService');
const { sendOutcomeFeedback } = require('../services/mlClient');

const populateTarget = async (report) => {
  if (report.targetType === 'product') {
    const doc = await Product.findById(report.target).select('title images status');
    report.target = doc;
  } else {
    const doc = await User.findById(report.target).select('name email');
    report.target = doc;
  }
};

const createReport = async (req, res, next) => {
  try {
    const { targetType, target, reason, description } = req.body;
    if (!targetType || !target || !reason) {
      throw new AppError('Target type, target and reason are required', 400, 'VALIDATION_ERROR');
    }

    if (!['product', 'user'].includes(targetType)) {
      throw new AppError('Invalid target type', 400, 'VALIDATION_ERROR');
    }

    if (targetType === 'product') {
      const exists = await Product.findById(target);
      if (!exists) throw new AppError('Product not found', 404, 'NOT_FOUND');
    } else {
      const exists = await User.findById(target);
      if (!exists) throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    const existing = await Report.findOne({
      reporter: req.user._id,
      target,
      targetType,
    });
    if (existing) {
      return res.json({ success: true, message: 'You have already reported this' });
    }

    const report = await Report.create({
      reporter: req.user._id,
      targetType,
      target,
      reason,
      description: description || '',
    });

    if (targetType === 'product') {
      const reportCount = await Report.countDocuments({ target, targetType: 'product' });
      if (reportCount >= 3) {
        await Product.updateOne({ _id: target }, { $set: { isFlagged: true, flagReason: 'multiple reports' } });
      }
    }

    res.status(201).json({ success: true, report });
  } catch (err) {
    next(err);
  }
};

const getReports = async (req, res, next) => {
  try {
    const status = req.query.status;
    const filter = {};
    if (status) filter.status = status;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Report.find(filter)
        .populate('reporter', 'name email')
        .populate('reviewedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Report.countDocuments(filter),
    ]);

    // Populate target based on targetType
    await Promise.all(
      items.map(async (r) => {
        await populateTarget(r);
      })
    );

    res.json({
      success: true,
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

const updateReport = async (req, res, next) => {
  try {
    const { status, action } = req.body;
    const report = await Report.findById(req.params.id);
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');

    if (status) report.status = status;
    if (action !== undefined) report.action = action;
    report.reviewedBy = req.user._id;
    report.reviewedAt = new Date();
    await report.save();

    // Human-confirmed fraud outcome → feedback for the ML pipeline. A
    // moderator resolving a product report with a recorded action is treated
    // as a ground-truth-positive label. Dismissed stays ambiguous (the
    // reporter may simply be mistaken), so we deliberately do not feed it
    // back as a negative.
    if (report.targetType === 'product' && status === 'resolved' && report.action) {
      await sendOutcomeFeedback({
        recordId: report.target,
        outcome: {
          decided: 'confirmed_fraud',
          reportAction: report.action,
        },
      });
    }

    // Notify the reporter their report was reviewed
    await notify({
      recipient: report.reporter,
      type: 'report_update',
      payload: {
        reportId: report._id,
        senderId: req.user._id,
        ...(report.targetType === 'product' ? { productId: report.target } : {}),
      },
    });

    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
};

module.exports = { createReport, getReports, updateReport };
