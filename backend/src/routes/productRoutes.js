const express = require('express');
const router = express.Router();
const AppError = require('../utils/AppError');
const {
  getProducts,
  getProduct,
  uploadImages,
  createProduct,
  updateProduct,
  deleteProduct,
  markAsSold,
  getMyProducts,
  getBrands,
  getSimilarProducts,
  getProductReviews,
  getProductIdentityStatus,
  submitPossessionVerification,
  requestPossession,
  suggestPrice,
} = require('../controllers/productController');
const { protect, optionalAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { productCreateLimiter } = require('../middleware/rateLimiters');
const { createAppeal } = require('../controllers/appealController');
const {
  createProductValidation,
  updateProductValidation,
  productQueryValidation,
  verifyPossessionValidation,
  createAppealValidation,
} = require('../middleware/validate');

router.get('/', optionalAuth, productQueryValidation, getProducts);
router.get('/suggest-price', optionalAuth, suggestPrice);
router.get('/brands', getBrands);
router.get('/mine', protect, getMyProducts);
router.get('/:id', optionalAuth, getProduct);
router.get('/:id/similar', optionalAuth, getSimilarProducts);
router.get('/:id/reviews', optionalAuth, getProductReviews);
router.get('/:id/identity', optionalAuth, getProductIdentityStatus);
router.post('/:id/appeal', protect, createAppealValidation, createAppeal);
router.post('/:id/identity/possession-challenge', protect, requestPossession);
router.post(
  '/:id/identity/verify-possession',
  protect,
  verifyPossessionValidation,
  submitPossessionVerification
);

router.post(
  '/upload-images',
  protect,
  (req, res, next) => {
    upload.array('images', 8)(req, res, (err) => {
      if (err) {
        // Multer validation errors (file type, count, size) are client
        // errors — 400, never a 500.
        return next(new AppError(err.message || 'Upload failed', 400, 'UPLOAD_INVALID'));
      }
      next();
    });
  },
  uploadImages
);
router.post('/', protect, productCreateLimiter, createProductValidation, createProduct);
router.put('/:id', protect, updateProductValidation, updateProduct);
router.delete('/:id', protect, deleteProduct);
router.patch('/:id/sold', protect, markAsSold);

module.exports = router;
