const Offer = require('../models/Offer');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');
const { notify } = require('../services/notificationService');

const createOffer = async (req, res, next) => {
  try {
    const { productId, amount, message } = req.body;

    const product = await Product.findById(productId);
    if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');
    if (product.status !== 'active') throw new AppError('Product is not available', 400, 'PRODUCT_UNAVAILABLE');
    if (product.seller.toString() === req.user._id.toString()) {
      throw new AppError('Cannot make an offer on your own product', 400, 'INVALID_OFFER');
    }

    // The offer currency is derived from the listing — a client-supplied
    // currencyCode is never trusted. Otherwise a buyer could create an
    // offer in a currency the checkout flow always rejects.
    const offer = await Offer.create({
      product: productId,
      buyer: req.user._id,
      seller: product.seller,
      amount,
      message: message || '',
      currencyCode: product.currencyCode || 'USD',
      history: [{ status: 'pending', actor: req.user._id, at: new Date() }],
    });

    const populated = await Offer.findById(offer._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the seller about the new incoming offer
    await notify({
      recipient: product.seller,
      type: 'offer',
      payload: { offerId: offer._id, productId, senderId: req.user._id },
    });

    res.status(201).json({ success: true, offer: populated });
  } catch (err) {
    next(err);
  }
};

const listOffers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [offers, total] = await Promise.all([
      Offer.find()
        .populate('product', 'title images price')
        .populate('buyer', 'name avatar')
        .populate('seller', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Offer.countDocuments(),
    ]);

    res.json({ success: true, offers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
};

const getMyOffers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [offers, total] = await Promise.all([
      Offer.find({ buyer: req.user._id })
        .populate('product', 'title images price status')
        .populate('seller', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Offer.countDocuments({ buyer: req.user._id }),
    ]);

    res.json({ success: true, offers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
};

const getReceivedOffers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [offers, total] = await Promise.all([
      Offer.find({ seller: req.user._id })
        .populate('product', 'title images price status')
        .populate('buyer', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Offer.countDocuments({ seller: req.user._id }),
    ]);

    res.json({ success: true, offers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
};

const getOffer = async (req, res, next) => {
  try {
    const offer = await Offer.findById(req.params.id)
      .populate('product', 'title images price currencyCode status')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    if (!offer) throw new AppError('Offer not found', 404, 'NOT_FOUND');

    // Only the offer's buyer, its seller, or an admin may view it
    const isBuyer = offer.buyer._id.toString() === req.user._id.toString();
    const isSeller = offer.seller._id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    if (!isBuyer && !isSeller && !isAdmin) {
      throw new AppError('Not authorized to view this offer', 403, 'FORBIDDEN');
    }

    res.json({ success: true, offer });
  } catch (err) {
    next(err);
  }
};

const updateOffer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, message } = req.body;

    const offer = await Offer.findById(id);
    if (!offer) throw new AppError('Offer not found', 404, 'NOT_FOUND');

    // Authorization: only the offer creator (buyer) or the listing's
    // seller may touch this offer — third parties are forbidden even
    // if they know the offer id.
    const isBuyer = offer.buyer.toString() === req.user._id.toString();
    const isSeller = offer.seller.toString() === req.user._id.toString();
    if (!isBuyer && !isSeller) {
      throw new AppError('Not authorized to update this offer', 403, 'FORBIDDEN');
    }

    // Preserve the model's state-transition rules
    if (!offer.canTransition(status)) {
      throw new AppError(`Cannot transition from ${offer.status} to ${status}`, 400, 'INVALID_TRANSITION');
    }

    // Role-restricted transitions on top of the state rules:
    //   buyer  -> withdrawn (cancel their own offer)
    //   seller -> accepted | rejected
    //   countered must go through POST /offers/:id/counter (needs an amount)
    //   expired is system-driven only
    if (status === 'withdrawn' && !isBuyer) {
      throw new AppError('Only the buyer can withdraw this offer', 403, 'FORBIDDEN');
    }
    if ((status === 'accepted' || status === 'rejected') && !isSeller) {
      throw new AppError('Only the seller can accept or reject this offer', 403, 'FORBIDDEN');
    }
    if (status === 'countered' || status === 'expired') {
      throw new AppError(
        status === 'countered'
          ? 'Use POST /offers/:id/counter to counter an offer'
          : 'Offers expire automatically and cannot be expired manually',
        400,
        'INVALID_TRANSITION'
      );
    }

    offer.status = status;
    offer.history.push({ status, actor: req.user._id, at: new Date(), note: message || '' });
    await offer.save();

    const populated = await Offer.findById(offer._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the other party about the outcome:
    //   buyer withdrew  -> notify seller
    //   seller accepted/rejected -> notify buyer
    if (status === 'withdrawn') {
      await notify({
        recipient: offer.seller,
        type: 'offer',
        payload: { offerId: offer._id, productId: offer.product, senderId: req.user._id },
      });
    } else if (status === 'accepted' || status === 'rejected') {
      await notify({
        recipient: offer.buyer,
        type: 'offer',
        payload: { offerId: offer._id, productId: offer.product, senderId: req.user._id },
      });
    }

    res.json({ success: true, offer: populated });
  } catch (err) {
    next(err);
  }
};

const acceptOffer = async (req, res, next) => {
  try {
    const { id } = req.params;

    // 'countered' is included because the model still allows the seller to
    // accept the buyer's original offer after countering it — matching the
    // dedicated endpoint to Offer.canTransition instead of 404ing on a valid
    // current offer.
    const offer = await Offer.findOneAndUpdate(
      { _id: id, seller: req.user._id, status: { $in: ['pending', 'countered'] } },
      {
        $set: { status: 'accepted' },
        $push: { history: { status: 'accepted', actor: req.user._id, at: new Date() } },
      },
      { new: true }
    );

    if (!offer) throw new AppError('Offer not found or already processed', 404, 'NOT_FOUND');

    const populated = await Offer.findById(offer._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the buyer their offer was accepted
    await notify({
      recipient: offer.buyer,
      type: 'offer',
      payload: { offerId: offer._id, productId: offer.product, senderId: req.user._id },
    });

    res.json({ success: true, offer: populated });
  } catch (err) {
    next(err);
  }
};

const rejectOffer = async (req, res, next) => {
  try {
    const { id } = req.params;

    const offer = await Offer.findOneAndUpdate(
      { _id: id, seller: req.user._id, status: { $in: ['pending', 'countered'] } },
      {
        $set: { status: 'rejected' },
        $push: { history: { status: 'rejected', actor: req.user._id, at: new Date() } },
      },
      { new: true }
    );

    if (!offer) throw new AppError('Offer not found or already processed', 404, 'NOT_FOUND');

    const populated = await Offer.findById(offer._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the buyer their offer was rejected
    await notify({
      recipient: offer.buyer,
      type: 'offer',
      payload: { offerId: offer._id, productId: offer.product, senderId: req.user._id },
    });

    res.json({ success: true, offer: populated });
  } catch (err) {
    next(err);
  }
};

const counterOffer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount, message } = req.body;

    const original = await Offer.findById(id);
    if (!original) throw new AppError('Offer not found', 404, 'NOT_FOUND');

    // Authorization: only the listing's seller can counter a buyer's
    // offer — third parties (and the buyer themself) are forbidden.
    if (original.seller.toString() !== req.user._id.toString()) {
      throw new AppError('Only the seller can counter this offer', 403, 'FORBIDDEN');
    }

    if (!original.canTransition('countered')) {
      throw new AppError(`Cannot counter offer in ${original.status} status`, 400, 'INVALID_TRANSITION');
    }

    original.status = 'countered';
    original.history.push({ status: 'countered', actor: req.user._id, at: new Date(), note: message || '' });
    await original.save();

    const newOffer = await Offer.create({
      product: original.product,
      buyer: original.buyer,
      seller: original.seller,
      amount,
      message: message || '',
      currencyCode: original.currencyCode,
      parentOffer: original._id,
      history: [{ status: 'pending', actor: req.user._id, at: new Date() }],
    });

    const populated = await Offer.findById(newOffer._id)
      .populate('product', 'title images price')
      .populate('buyer', 'name avatar')
      .populate('seller', 'name avatar');

    // Notify the buyer about the seller's counter offer
    await notify({
      recipient: original.buyer,
      type: 'offer',
      payload: { offerId: newOffer._id, productId: original.product, senderId: req.user._id },
    });

    res.status(201).json({ success: true, offer: populated });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createOffer,
  listOffers,
  getMyOffers,
  getReceivedOffers,
  getOffer,
  updateOffer,
  acceptOffer,
  rejectOffer,
  counterOffer,
};
