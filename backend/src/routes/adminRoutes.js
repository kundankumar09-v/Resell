const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getAllUsers,
  updateUser,
  deleteUser,
  getAllProducts,
  moderateProduct,
  markIdentityStatus,
  getAnalytics,
} = require('../controllers/adminController');
const { protect, authorize } = require('../middleware/auth');
const {
  updateUserValidation,
  moderateProductValidation,
  markIdentityStatusValidation,
  decideAppealValidation,
} = require('../middleware/validate');
const { listAppeals, decideAppeal } = require('../controllers/appealController');

router.use(protect, authorize('admin'));

router.get('/stats', getDashboardStats);
router.get('/analytics', getAnalytics);

router.get('/users', getAllUsers);
router.put('/users/:id', updateUserValidation, updateUser);
router.delete('/users/:id', deleteUser);

router.get('/products', getAllProducts);
router.put('/products/:id', moderateProductValidation, moderateProduct);

// Product identity registry (stolen/flagged status) — admin/moderator only
router.put('/identities/:id/status', markIdentityStatusValidation, markIdentityStatus);

// Flag appeals — decided by admins; approved appeals clear the automated flag
router.get('/appeals', listAppeals);
router.put('/appeals/:id', decideAppealValidation, decideAppeal);

module.exports = router;
