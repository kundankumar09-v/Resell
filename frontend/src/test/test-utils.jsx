import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mock providers for isolated component testing
const mockAuthValue = {
  user: { _id: '1', name: 'Test User', email: 'test@test.com', role: 'buyer' },
  loading: false,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
};

const mockSocketValue = {
  socket: null,
  connected: true,
  totalUnread: 0,
  onlineUsers: new Set(),
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  joinConversation: vi.fn(),
  leaveConversation: vi.fn(),
  emitTyping: vi.fn(),
  emitStopTyping: vi.fn(),
  setUnread: vi.fn(),
  incrementUnread: vi.fn(),
  clearUnread: vi.fn(),
};

const mockCurrencyValue = {
  currency: 'USD',
  base: 'USD',
  rates: { USD: 1, EUR: 0.92 },
  supported: ['USD', 'EUR', 'GBP'],
  setCurrency: vi.fn(),
  refreshRates: vi.fn(),
};

// vi.mock factories are hoisted to module scope, so they cannot close over
// per-render locals. Keep the active values in a module-level holder that
// renderWithProviders swaps before each render.
const active = {
  auth: mockAuthValue,
  socket: mockSocketValue,
  currency: mockCurrencyValue,
};

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => active.auth,
  AuthProvider: ({ children }) => children,
}));

vi.mock('../contexts/SocketContext', () => ({
  useSocket: () => active.socket,
  SocketProvider: ({ children }) => children,
}));

vi.mock('../contexts/CurrencyContext', () => ({
  useCurrency: () => active.currency,
  CurrencyProvider: ({ children }) => children,
}));

export function renderWithProviders(ui, { authValue, socketValue, currencyValue, route = '/' } = {}) {
  active.auth = { ...mockAuthValue, ...authValue };
  active.socket = { ...mockSocketValue, ...socketValue };
  active.currency = { ...mockCurrencyValue, ...currencyValue };

  return render(
    <BrowserRouter>
      {ui}
    </BrowserRouter>
  );
}

export { mockAuthValue, mockSocketValue, mockCurrencyValue };
