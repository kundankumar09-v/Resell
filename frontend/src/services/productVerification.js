import api from './api';

// Possession-verification endpoints (SCRUM-25). Kept in a dedicated module
// so the possession flow is self-contained: request challenge -> display
// code + instructions -> upload proof -> submit -> status (pending /
// verified / failed / expired).
export const productVerificationService = {
  request: (id) => api.post(`/products/${id}/identity/possession-challenge`),
  status: (id) => api.get(`/products/${id}/identity`),
  verify: (id, data) => api.post(`/products/${id}/identity/verify-possession`, data),
};
