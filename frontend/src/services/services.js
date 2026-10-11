import api from './api';

export const authService = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  updateProfile: (data) => api.put('/auth/profile', data),
  changePassword: (data) => api.put('/auth/password', data),
};

export const productService = {
  list: (params) => api.get('/products', { params }),
  get: (id) => api.get(`/products/${id}`),
  my: () => api.get('/products/mine'),
  brands: () => api.get('/products/brands'),
  similar: (id) => api.get(`/products/${id}/similar`),
  reviews: (id) => api.get(`/products/${id}/reviews`),
  suggestPrice: (params) => api.get('/products/suggest-price', { params }),
  uploadImages: (formData) =>
    api.post('/products/upload-images', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  create: (data) => api.post('/products', data),
  update: (id, data) => api.put(`/products/${id}`, data),
  delete: (id) => api.delete(`/products/${id}`),
  markSold: (id) => api.patch(`/products/${id}/sold`),
  identityStatus: (id) => api.get(`/products/${id}/identity`),
  verifyPossession: (id, data) => api.post(`/products/${id}/identity/verify-possession`, data),
};

export const categoryService = {
  list: () => api.get('/categories'),
  get: (slug) => api.get(`/categories/${slug}`),
  stats: () => api.get('/categories/stats'),
  create: (data) => api.post('/categories', data),
  update: (id, data) => api.put(`/categories/${id}`, data),
  remove: (id) => api.delete(`/categories/${id}`),
};

export const favoriteService = {
  list: () => api.get('/favorites'),
  check: (id) => api.get(`/favorites/${id}/check`),
  add: (id) => api.post(`/favorites/${id}`),
  remove: (id) => api.delete(`/favorites/${id}`),
};

export const chatService = {
  conversations: () => api.get('/chat/conversations', { _noCache: true }),
  createConversation: (data) => api.post('/chat/conversations', data),
  messages: (id, params) => api.get(`/chat/conversations/${id}/messages`, { params, _noCache: true }),
  send: (data) => api.post('/chat/messages', data),
  markRead: (id) => api.post(`/chat/conversations/${id}/read`),
  unreadCount: () => api.get('/chat/unread-count', { _noCache: true }),
};

export const reportService = {
  create: (data) => api.post('/reports', data),
  list: (params) => api.get('/reports', { params }),
  update: (id, data) => api.put(`/reports/${id}`, data),
};

export const sellerService = {
  profile: (id) => api.get(`/sellers/${id}`),
  trust: (id) => api.get(`/sellers/${id}/trust`),
  review: (id, data) => api.post(`/sellers/${id}/reviews`, data),
  similar: (id) => api.get(`/sellers/${id}/similar`),
};

export const offerService = {
  create: (data) => api.post('/offers', data),
  list: (params) => api.get('/offers', { params, _noCache: true }),
  get: (id) => api.get(`/offers/${id}`, { _noCache: true }),
  mine: () => api.get('/offers/mine', { _noCache: true }),
  received: () => api.get('/offers/received', { _noCache: true }),
  update: (id, data) => api.put(`/offers/${id}`, data),
  accept: (id) => api.post(`/offers/${id}/accept`),
  reject: (id) => api.post(`/offers/${id}/reject`),
  counter: (id, data) => api.post(`/offers/${id}/counter`, data),
};

export const adminService = {
  stats: () => api.get('/admin/stats'),
  analytics: () => api.get('/admin/analytics'),
  users: (params) => api.get('/admin/users', { params }),
  updateUser: (id, data) => api.put(`/admin/users/${id}`, data),
  deleteUser: (id) => api.delete(`/admin/users/${id}`),
  products: (params) => api.get('/admin/products', { params }),
  moderateProduct: (id, data) => api.put(`/admin/products/${id}`, data),
};

export const notificationService = {
  list: (params) => api.get('/notifications', { params }),
  unread: () => api.get('/notifications/unread'),
  markRead: (id) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),
};

export const checkoutService = {
  createSession: (data) => api.post('/checkout/session', data),
};

export const orderService = {
  myOrders: (params) => api.get('/orders/mine', { params }),
  mySales: (params) => api.get('/orders/selling', { params }),
  get: (id) => api.get(`/orders/${id}`),
  ship: (id, data) => api.patch(`/orders/${id}/ship`, data),
  deliver: (id) => api.patch(`/orders/${id}/deliver`),
  cancel: (id) => api.post(`/orders/${id}/cancel`),
};

export const appealService = {
  create: (productId, data) => api.post(`/products/${productId}/appeal`, data),
};
export const adminAppealService = {
  list: (params) => api.get('/admin/appeals', { params }),
  decide: (id, data) => api.put(`/admin/appeals/${id}`, data),
};
