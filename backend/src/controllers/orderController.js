const Sale = require('../models/Sale');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');
const { recordSaleProvenance } = require('../services/identityVerification');
const stripeService = require('../services/stripeService');
const { notify } = require('../services/notificationService');

const getMyOrders = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      Sale.find({ buyer: req.user._id })
        .populate('product', 'title images price status')
        .populate('seller', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Sale.countDocuments({ buyer: req.user._id }),
    ]);

    res.json({ success: true, orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
};

const getMySales = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [sales, total] = await Promise.all([
      Sale.find({ seller: req.user._id })
        .populate('product', 'title images price status')
        .populate('buyer', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Sale.countDocuments({ seller: req.user._id }),
    ]);

    res.json({ success: true, sales, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
};

const getOrder = async (req, res, next) => {
  try {
    const sale = await Sale.findById(req.params.id)
      .populate('product', 'title images price status')
      .populate('buyer', 'name avatar email')
      .populate('seller', 'name avatar email');

    if (!sale) throw new AppError('Order not found', 404, 'NOT_FOUND');

    // Only participants or admins can view
    const isBuyer = sale.buyer._id.toString() === req.user._id.toString();
    const isSeller = sale.seller._id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isBuyer && !isSeller && !isAdmin) {
      throw new AppError('Not authorized', 403, 'FORBIDDEN');
    }

    res.json({ success: true, order: sale });
  } catch (err) {
    next(err);
  }
};

const shipOrder = async (req, res, next) => {
  try {
    const { trackingNumber } = req.body;
    const sale = await Sale.findById(req.params.id);
    if (!sale) throw new AppError('Order not found', 404, 'NOT_FOUND');

    if (sale.seller.toString() !== req.user._id.toString()) {
      throw new AppError('Only the seller can ship this order', 403, 'FORBIDDEN');
    }

    if (!sale.canTransition('shipped')) {
      throw new AppError(`Cannot ship order in ${sale.status} status`, 400, 'INVALID_TRANSITION');
    }

    sale.transition('shipped', req.user._id, trackingNumber ? `Tracking: ${trackingNumber}` : '');
    sale.trackingNumber = trackingNumber || null;
    sale.shippedAt = new Date();
    await sale.save();

    const populated = await Sale.findById(sale._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the buyer that their order shipped (includes tracking)
    await notify({
      recipient: sale.buyer,
      type: 'order',
      payload: { saleId: sale._id, productId: sale.product, senderId: req.user._id },
    });

    res.json({ success: true, order: populated });
  } catch (err) {
    next(err);
  }
};

const deliverOrder = async (req, res, next) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) throw new AppError('Order not found', 404, 'NOT_FOUND');

    if (sale.buyer.toString() !== req.user._id.toString()) {
      throw new AppError('Only the buyer can confirm delivery', 403, 'FORBIDDEN');
    }

    if (!sale.canTransition('delivered')) {
      throw new AppError(`Cannot confirm delivery for order in ${sale.status} status`, 400, 'INVALID_TRANSITION');
    }

    sale.transition('delivered', req.user._id, 'Buyer confirmed receipt');
    sale.deliveredAt = new Date();
    await sale.save();

    // Provenance: ownership transfers to the buyer (server-side, best-effort)
    await recordSaleProvenance({
      productId: sale.product ? sale.product.toString() : sale.product,
      sellerId: sale.seller.toString(),
      buyerId: sale.buyer.toString(),
      transactionId: sale.stripePaymentIntentId,
      eventType: 'ownership_transferred',
    });

    const populated = await Sale.findById(sale._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the seller that the buyer confirmed delivery
    await notify({
      recipient: sale.seller,
      type: 'order',
      payload: { saleId: sale._id, productId: sale.product, senderId: req.user._id },
    });

    res.json({ success: true, order: populated });
  } catch (err) {
    next(err);
  }
};

const cancelOrder = async (req, res, next) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) throw new AppError('Order not found', 404, 'NOT_FOUND');

    const isBuyer = sale.buyer.toString() === req.user._id.toString();
    const isSeller = sale.seller.toString() === req.user._id.toString();

    if (!isBuyer && !isSeller) {
      throw new AppError('Not authorized to cancel this order', 403, 'FORBIDDEN');
    }

    if (sale.status === 'paid') {
      // Must refund via Stripe, not just cancel
      if (!sale.stripePaymentIntentId) {
        throw new AppError('No payment to refund', 400, 'NO_PAYMENT');
      }
      await stripeService.createRefund(sale);
    } else if (sale.status === 'pending_payment') {
      // Release the product
      await Product.findByIdAndUpdate(sale.product, { status: 'active' });
      sale.transition('cancelled', req.user._id, 'Cancelled by user');
      await sale.save();
    } else {
      throw new AppError(`Cannot cancel order in ${sale.status} status`, 400, 'INVALID_TRANSITION');
    }

    // Provenance: ownership reverts to the seller on cancellation/refund
    // and the product identity becomes active again (best-effort).
    await recordSaleProvenance({
      productId: sale.product ? sale.product.toString() : sale.product,
      sellerId: sale.seller.toString(),
      buyerId: sale.buyer.toString(),
      transactionId: sale.stripePaymentIntentId,
      eventType: 'sale_cancelled',
    });

    const populated = await Sale.findById(sale._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the other participant about the cancellation
    // (paid cancellations go through a Stripe refund)
    const recipient = isBuyer ? sale.seller : sale.buyer;
    await notify({
      recipient,
      type: 'order',
      payload: { saleId: sale._id, productId: sale.product, senderId: req.user._id },
    });

    res.json({ success: true, order: populated });
  } catch (err) {
    next(err);
  }
};

module.exports = { getMyOrders, getMySales, getOrder, shipOrder, deliverOrder, cancelOrder };
