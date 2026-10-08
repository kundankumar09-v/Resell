const User = require('../models/User');
const Product = require('../models/Product');
const Report = require('../models/Report');
const Sale = require('../models/Sale');
const Review = require('../models/Review');
const Category = require('../models/Category');
const Conversation = require('../models/Conversation');
const AuditLog = require('../models/AuditLog');
const AppError = require('../utils/AppError');
const { notify } = require('../services/notificationService');
const { setIdentityStatus } = require('../services/identityVerification');

const getDashboardStats = async (req, res, next) => {
  try {
    const now = new Date();
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalSellers,
      totalProducts,
      activeProducts,
      soldProducts,
      totalReports,
      pendingReports,
      totalSales,
      totalReviews,
      newUsersLast7Days,
      newProductsLast7Days,
      totalRevenueAgg,
    ] = await Promise.all([
      User.countDocuments({ role: { $in: ['buyer', 'seller'] } }),
      User.countDocuments({ role: 'seller' }),
      Product.countDocuments({ status: { $ne: 'removed' } }),
      Product.countDocuments({ status: 'active' }),
      Product.countDocuments({ status: 'sold' }),
      Report.countDocuments(),
      Report.countDocuments({ status: 'pending' }),
      Sale.countDocuments(),
      Review.countDocuments(),
      User.countDocuments({ createdAt: { $gte: last7Days } }),
      Product.countDocuments({ createdAt: { $gte: last7Days } }),
      Sale.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$salePrice' } } },
      ]),
    ]);

    const totalRevenue = totalRevenueAgg[0]?.total || 0;

    // Recent activity
    const recentProducts = await Product.find({ status: { $ne: 'removed' } })
      .populate('seller', 'name email')
      .populate('category', 'name')
      .sort({ createdAt: -1 })
      .limit(10);

    const flaggedProducts = await Product.find({ isFlagged: true })
      .populate('seller', 'name email')
      .populate('category', 'name')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      stats: {
        totalUsers,
        totalSellers,
        totalProducts,
        activeProducts,
        soldProducts,
        totalReports,
        pendingReports,
        totalSales,
        totalReviews,
        totalRevenue,
        newUsersLast7Days,
        newProductsLast7Days,
      },
      recentProducts,
      flaggedProducts,
    });
  } catch (err) {
    next(err);
  }
};

const getAllUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.q) {
      // Escape regex metacharacters — same ReDoS/injection defense as the
      // public product filters (admin-only route, but never trust input).
      const escaped = req.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: new RegExp(escaped, 'i') },
        { email: new RegExp(escaped, 'i') },
      ];
    }
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;

    const [items, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
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

const updateUser = async (req, res, next) => {
  try {
    const updates = {};
    ['role', 'isActive', 'isVerified', 'complaints'].forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    if (req.body.suspendedUntil !== undefined) {
      updates.suspendedUntil = req.body.suspendedUntil ? new Date(req.body.suspendedUntil) : null;
    }

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

    // Notify the affected user about the admin action
    await notify({
      recipient: user._id,
      type: 'admin_action',
      payload: { senderId: req.user._id },
    });

    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

const deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');
    if (user.role === 'admin') {
      throw new AppError('Cannot delete admin user', 400, 'CANNOT_DELETE_ADMIN');
    }
    user.isActive = false;
    await user.save();
    res.json({ success: true, message: 'User deactivated' });
  } catch (err) {
    next(err);
  }
};

const getAllProducts = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.q) {
      // Escape regex metacharacters — same ReDoS/injection defense as the
      // public product filters (admin-only route, but never trust input).
      const escaped = req.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: new RegExp(escaped, 'i') },
        { description: new RegExp(escaped, 'i') },
      ];
    }
    if (req.query.flagged === 'true') filter.isFlagged = true;

    const [items, total] = await Promise.all([
      Product.find(filter)
        .populate('category', 'name slug')
        .populate('seller', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Product.countDocuments(filter),
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

const moderateProduct = async (req, res, next) => {
  try {
    const { status, isFlagged, flagReason } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (isFlagged !== undefined) updates.isFlagged = isFlagged;
    if (flagReason !== undefined) updates.flagReason = flagReason;

    const product = await Product.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');

    // Notify the seller their listing was moderated
    await notify({
      recipient: product.seller,
      type: 'admin_action',
      payload: { productId: product._id, senderId: req.user._id },
    });

    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
};

/**
 * Mark a product identity's registry status (reported_stolen / flagged /
 * active). Admin-only (enforced by the router). Creates a hash-chained
 * 'reported' provenance event, an AuditLog entry, and — when a report
 * triggered the action — resolves that Report. Future listings with the
 * same identifier are blocked (reported_stolen) or held (flagged) by
 * the listing-creation flow. Only safe fields are ever returned — the
 * identifier hash is never exposed.
 */
const markIdentityStatus = async (req, res, next) => {
  try {
    const { status, reportId, note } = req.body;

    const identity = await setIdentityStatus({
      identityId: req.params.id,
      status,
      moderatorId: req.user._id,
      reportId,
    });

    // Hold or release the currently linked listing per the moderation flow
    if (identity.productId) {
      if (status === 'reported_stolen' || status === 'flagged') {
        await Product.findByIdAndUpdate(identity.productId, {
          status: 'flagged',
          isFlagged: true,
          flagReason:
            status === 'reported_stolen'
              ? 'Product identifier reported as stolen'
              : 'Product identity flagged for review',
        });
      } else if (status === 'active') {
        await Product.findByIdAndUpdate(identity.productId, {
          status: 'active',
          isFlagged: false,
          flagReason: '',
        });
      }
    }

    // Audit the moderator action
    await AuditLog.create({
      actor: req.user._id,
      action: 'identity_status_update',
      targetType: 'productidentity',
      target: identity._id,
      metadata: { status, reportId: reportId || null, note: note || '' },
    });

    // Connect the triggering Report to the identity and resolve it
    if (reportId) {
      await Report.findByIdAndUpdate(
        reportId,
        {
          status: 'resolved',
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
          action: `identity_marked_${status}`,
        },
        { new: true }
      );
    }

    // Never expose the identifier hash, verification secrets, or owner details
    res.json({
      success: true,
      identity: {
        _id: identity._id,
        identifierType: identity.identifierType,
        status: identity.status,
        // Identity mode ('visual' = possession-based) + possession status
        possessionMethod: identity.verification?.method || 'none',
        possessionStatus: identity.verification?.possessionStatus || 'unverified',
        // Related listing so moderation can inspect fraud factors there
        productId: identity.productId || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

const getAnalytics = async (req, res, next) => {
  try {
    const last30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      usersByDay,
      productsByDay,
      topCategories,
      topSellers,
      priceRanges,
    ] = await Promise.all([
      User.aggregate([
        { $match: { createdAt: { $gte: last30Days } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Product.aggregate([
        { $match: { createdAt: { $gte: last30Days } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Product.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: 'categories',
            localField: '_id',
            foreignField: '_id',
            as: 'category',
          },
        },
        { $unwind: '$category' },
        { $project: { name: '$category.name', count: 1 } },
      ]),
      Product.aggregate([
        { $match: { status: { $in: ['active', 'sold'] } } },
        { $group: { _id: '$seller', count: { $sum: 1 }, sold: { $sum: { $cond: [{ $eq: ['$status', 'sold'] }, 1, 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'seller',
          },
        },
        { $unwind: '$seller' },
        {
          $project: {
            name: '$seller.name',
            avatar: '$seller.avatar',
            count: 1,
            sold: 1,
          },
        },
      ]),
      Product.aggregate([
        { $match: { status: { $in: ['active', 'sold'] } } },
        {
          $bucket: {
            groupBy: '$price',
            boundaries: [0, 50, 100, 250, 500, 1000, 2500, 5000, 100000],
            default: 'Other',
            output: { count: { $sum: 1 } },
          },
        },
      ]),
    ]);

    res.json({
      success: true,
      analytics: {
        usersByDay,
        productsByDay,
        topCategories,
        topSellers,
        priceRanges,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getDashboardStats,
  getAllUsers,
  updateUser,
  deleteUser,
  getAllProducts,
  moderateProduct,
  markIdentityStatus,
  getAnalytics,
};
