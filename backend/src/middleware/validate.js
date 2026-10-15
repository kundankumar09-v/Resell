const { body, param, query, validationResult } = require('express-validator');
const AppError = require('../utils/AppError');
const SHARED_LIMITS = require('../constants');

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => `${e.path}: ${e.msg}`).join('; ');
    return next(new AppError(messages, 400, 'VALIDATION_ERROR'));
  }
  next();
};

const registerValidation = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }).withMessage('Name too long'),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').optional().isIn(['buyer', 'seller']).withMessage('Invalid role'),
  body('location').optional().isString().trim(),
  handleValidation,
];

const loginValidation = [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  handleValidation,
];

const updateProfileValidation = [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty').isLength({ max: 60 }).withMessage('Name too long'),
  body('bio').optional().isString().isLength({ max: 500 }).withMessage('Bio too long'),
  body('phone').optional().isString().trim().isLength({ max: 20 }).withMessage('Phone too long').matches(/^[\d\s+\-()]*$/).withMessage('Invalid phone format'),
  body('location').optional().isString(),
  body('avatar').optional().isObject(),
  handleValidation,
];

const changePasswordValidation = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  handleValidation,
];

const createProductValidation = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 120 }).withMessage('Title too long'),
  body('description').trim().notEmpty().withMessage('Description is required').isLength({ max: 4000 }).withMessage('Description too long'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('originalPrice').optional().isFloat({ min: 0 }).withMessage('Original price must be a positive number'),
  body('currencyCode').optional().isString().isLength({ min: 3, max: 3 }).withMessage('currencyCode must be a 3-letter code'),
  body('category').notEmpty().withMessage('Category is required').isMongoId().withMessage('Invalid category ID'),
  body('brand').optional().isString().trim().isLength({ max: 100 }),
  body('model').optional().isString().trim().isLength({ max: 100 }),
  body('condition').optional().isIn(['new', 'like-new', 'good', 'fair', 'poor']).withMessage('Invalid condition'),
  body('yearsUsed').optional().isInt({ min: 0 }).withMessage('Years used must be a positive integer'),
  body('specifications').optional().isArray().withMessage('Specifications must be an array'),
  body('specifications.*.key').optional().isString().trim(),
  body('specifications.*.value').optional().isString().trim(),
  body('location').optional().isObject(),
  body('location.city').optional().isString(),
  body('location.state').optional().isString(),
  body('location.country').optional().isString(),
  body('images').isArray({ min: SHARED_LIMITS.MIN_IMAGES }).withMessage('At least 3 images are required'),
  body('images.*.url').notEmpty().withMessage('Image URL is required').isURL().withMessage('Invalid image URL'),
  body('images.*.publicId').notEmpty().withMessage('Image publicId is required'),
  body('images.*.hash').optional().isString(),
  handleValidation,
];

const updateProductValidation = [
  param('id').isMongoId().withMessage('Invalid product ID'),
  body('title').optional().trim().notEmpty().withMessage('Title cannot be empty').isLength({ max: 120 }).withMessage('Title too long'),
  body('description').optional().trim().notEmpty().withMessage('Description cannot be empty').isLength({ max: 4000 }).withMessage('Description too long'),
  body('price').optional().isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('originalPrice').optional().isFloat({ min: 0 }).withMessage('Original price must be a positive number'),
  body('category').optional().isMongoId().withMessage('Invalid category ID'),
  body('brand').optional().isString().trim().isLength({ max: 100 }),
  body('model').optional().isString().trim().isLength({ max: 100 }),
  body('condition').optional().isIn(['new', 'like-new', 'good', 'fair', 'poor']).withMessage('Invalid condition'),
  body('yearsUsed').optional().isInt({ min: 0 }).withMessage('Years used must be a positive integer'),
  body('specifications').optional().isArray().withMessage('Specifications must be an array'),
  body('images').optional().isArray().withMessage('Images must be an array'),
  body('primaryObjectIndex').optional().isInt({ min: 0 }).withMessage('primaryObjectIndex must be a non-negative integer'),
  handleValidation,
];

const createCategoryValidation = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }).withMessage('Name too long'),
  body('description').optional().isString().trim(),
  body('icon').optional().isString(),
  body('image').optional().isString(),
  body('parent').optional().isMongoId().withMessage('Invalid parent category ID'),
  handleValidation,
];

const updateCategoryValidation = [
  param('id').isMongoId().withMessage('Invalid category ID'),
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty').isLength({ max: 100 }).withMessage('Name too long'),
  body('description').optional().isString().trim(),
  body('icon').optional().isString(),
  body('image').optional().isString(),
  body('parent').optional().isMongoId().withMessage('Invalid parent category ID'),
  body('isActive').optional().isBoolean().withMessage('isActive must be boolean'),
  handleValidation,
];

const createConversationValidation = [
  body('recipientId').notEmpty().withMessage('Recipient is required').isMongoId().withMessage('Invalid recipient ID'),
  body('productId').optional().isMongoId().withMessage('Invalid product ID'),
  handleValidation,
];

const sendMessageValidation = [
  body('conversationId').notEmpty().withMessage('Conversation is required').isMongoId().withMessage('Invalid conversation ID'),
  body('content').optional({ checkFalsy: true }).trim().isLength({ max: 2000 }).withMessage('Message too long'),
  body('attachments').optional().isArray().withMessage('Attachments must be an array'),
  body('attachments.*.url').optional().notEmpty().withMessage('Attachment URL is required'),
  body('attachments.*.publicId').optional().isString(),
  handleValidation,
];

const getMessagesValidation = [
  param('id').isMongoId().withMessage('Invalid conversation ID'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  handleValidation,
];

const createReportValidation = [
  body('targetType').notEmpty().withMessage('Target type is required').isIn(['product', 'user']).withMessage('Invalid target type'),
  body('target').notEmpty().withMessage('Target is required').isMongoId().withMessage('Invalid target ID'),
  body('reason').notEmpty().withMessage('Reason is required').isIn(['spam', 'fake', 'fraud', 'inappropriate', 'duplicate', 'other']).withMessage('Invalid reason'),
  body('description').optional().isString().trim().isLength({ max: 1000 }).withMessage('Description too long'),
  handleValidation,
];

const updateReportValidation = [
  param('id').isMongoId().withMessage('Invalid report ID'),
  body('status').optional().isIn(['pending', 'reviewing', 'resolved', 'dismissed']).withMessage('Invalid status'),
  body('action').optional().isString().trim().isLength({ max: 500 }).withMessage('Action too long'),
  handleValidation,
];

const updateUserValidation = [
  param('id').isMongoId().withMessage('Invalid user ID'),
  body('role').optional().isIn(['buyer', 'seller', 'admin']).withMessage('Invalid role'),
  body('isActive').optional().isBoolean().withMessage('isActive must be boolean'),
  body('isVerified').optional().isBoolean().withMessage('isVerified must be boolean'),
  body('complaints').optional().isInt({ min: 0 }).withMessage('Complaints must be a positive integer'),
  body('suspendedUntil').optional().isISO8601().withMessage('Invalid date format'),
  handleValidation,
];

const moderateProductValidation = [
  param('id').isMongoId().withMessage('Invalid product ID'),
  body('status').optional().isIn(['active', 'sold', 'pending', 'rejected', 'removed']).withMessage('Invalid status'),
  body('isFlagged').optional().isBoolean().withMessage('isFlagged must be boolean'),
  body('flagReason').optional().isString().trim().isLength({ max: 500 }).withMessage('Flag reason too long'),
  handleValidation,
];

const addReviewValidation = [
  param('id').isMongoId().withMessage('Invalid seller ID'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('comment').optional().isString().trim().isLength({ max: 1000 }).withMessage('Comment too long'),
  body('product').optional().isMongoId().withMessage('Invalid product ID'),
  handleValidation,
];

const favoriteValidation = [
  param('productId').isMongoId().withMessage('Invalid product ID'),
  handleValidation,
];

const productQueryValidation = [
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  query('sort').optional({ checkFalsy: true }).isIn(['price-asc', 'price-desc', 'newest', 'oldest', 'popular']).withMessage('Invalid sort option'),
  query('q').optional({ checkFalsy: true }).isString().trim(),
  query('category').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid category ID'),
  query('brand').optional({ checkFalsy: true }).isString().trim(),
  query('condition').optional({ checkFalsy: true }).isIn(['new', 'like-new', 'good', 'fair', 'poor']).withMessage('Invalid condition'),
  query('minPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Min price must be positive'),
  query('maxPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Max price must be positive'),
  query('location').optional({ checkFalsy: true }).isString().trim(),
  handleValidation,
];

const createOfferValidation = [
  body('productId').notEmpty().withMessage('Product is required').isMongoId().withMessage('Invalid product ID'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be a positive number'),
  body('message').optional().isString().trim().isLength({ max: 500 }).withMessage('Message too long'),
  body('currencyCode').optional().isString().isLength({ min: 3, max: 3 }).withMessage('currencyCode must be 3 letters'),
  handleValidation,
];

const counterOfferValidation = [
  param('id').isMongoId().withMessage('Invalid offer ID'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be a positive number'),
  body('message').optional().isString().trim().isLength({ max: 500 }),
  handleValidation,
];

const createCheckoutSessionValidation = [
  body('productId').notEmpty().withMessage('Product ID is required').isMongoId().withMessage('Invalid product ID'),
  body('offerId').optional().isMongoId().withMessage('Invalid offer ID'),
  body('shippingAddress').optional().isObject().withMessage('Shipping address must be an object'),
  body('shippingAddress.fullName').optional().isString().trim().notEmpty(),
  body('shippingAddress.phone').optional().isString().trim().notEmpty(),
  body('shippingAddress.line1').optional().isString().trim().notEmpty(),
  body('shippingAddress.city').optional().isString().trim().notEmpty(),
  body('shippingAddress.postalCode').optional().isString().trim().notEmpty(),
  body('shippingAddress.country').optional().isString().trim().notEmpty(),
  handleValidation,
];

const verifyPossessionValidation = [
  param('id').isMongoId().withMessage('Invalid product ID'),
  body('proofImageUrl').isURL().withMessage('A valid proof photo URL is required'),
  body('code').notEmpty().withMessage('Verification code is required').isString().trim(),
  handleValidation,
];

const markIdentityStatusValidation = [
  param('id').isMongoId().withMessage('Invalid identity ID'),
  body('status').isIn(['active', 'flagged', 'reported_stolen']).withMessage('Invalid identity status'),
  body('reportId').optional().isMongoId().withMessage('Invalid report ID'),
  body('note').optional().isString().trim().isLength({ max: 500 }).withMessage('Note too long'),
  handleValidation,
];

const createAppealValidation = [
  param('id').isMongoId().withMessage('Invalid product ID'),
  body('reason').notEmpty().withMessage('Appeal reason is required').isString().trim().isLength({ max: 2000 }).withMessage('Appeal reason too long'),
  handleValidation,
];

const decideAppealValidation = [
  param('id').isMongoId().withMessage('Invalid appeal ID'),
  body('status').isIn(['approved', 'rejected']).withMessage('Invalid appeal status'),
  body('moderatorNote').optional().isString().trim().isLength({ max: 2000 }).withMessage('Note too long'),
  handleValidation,
];

module.exports = {
  handleValidation,
  registerValidation,
  loginValidation,
  updateProfileValidation,
  changePasswordValidation,
  createProductValidation,
  updateProductValidation,
  createCategoryValidation,
  updateCategoryValidation,
  createConversationValidation,
  sendMessageValidation,
  getMessagesValidation,
  createReportValidation,
  updateReportValidation,
  updateUserValidation,
  moderateProductValidation,
  addReviewValidation,
  productQueryValidation,
  favoriteValidation,
  createOfferValidation,
  counterOfferValidation,
  createCheckoutSessionValidation,
  verifyPossessionValidation,
  markIdentityStatusValidation,
  createAppealValidation,
  decideAppealValidation,
};