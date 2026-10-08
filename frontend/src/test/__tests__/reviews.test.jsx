import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../../services/services', () => ({
  productService: {
    get: vi.fn(),
    similar: vi.fn(),
    reviews: vi.fn(),
    identityStatus: vi.fn(),
  },
  favoriteService: {
    check: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
  },
  chatService: {
    createConversation: vi.fn(),
    send: vi.fn(),
  },
  reportService: { create: vi.fn() },
  sellerService: {
    trust: vi.fn(),
    review: vi.fn(),
    profile: vi.fn(),
  },
  offerService: { create: vi.fn() },
}));

vi.mock('../../contexts/AuthContext', () => {
  // Stable reference — ProductDetail's effects depend on `user`, so a new
  // object per render would cause an infinite effect loop in tests.
  const user = { _id: 'u1', name: 'Test User', email: 'test@test.com', role: 'buyer' };
  const logout = vi.fn();
  return {
    useAuth: () => ({ user, logout }),
  };
});

vi.mock('../../contexts/CurrencyContext', () => ({
  useCurrency: () => ({
    currency: 'USD',
    base: 'USD',
    rates: { USD: 1 },
    supported: ['USD'],
    setCurrency: vi.fn(),
    refreshRates: vi.fn(),
    loading: false,
  }),
}));

import { productService, sellerService, favoriteService } from '../../services/services';
import ProductDetail from '../../pages/ProductDetail';
import SellerProfile from '../../pages/SellerProfile';

const product = {
  _id: 'p1',
  title: 'Vintage Camera',
  description: 'A fine camera for testing',
  price: 400,
  currencyCode: 'USD',
  condition: 'good',
  status: 'active',
  createdAt: new Date().toISOString(),
  views: 10,
  favoritesCount: 2,
  images: [{ url: 'http://x.com/cam.jpg' }],
  category: { name: 'Photography', slug: 'photography' },
  seller: { _id: 's1', name: 'Seller Sam', location: 'Springfield, US' },
  aiAnalysis: null,
  specifications: [],
  location: { city: 'Springfield', country: 'US' },
};

const reviewFixture = {
  _id: 'rev1',
  rating: 5,
  comment: 'Exactly as described, fast shipping!',
  createdAt: new Date().toISOString(),
  buyer: { _id: 'b1', name: 'Buyer Betty' },
};

const renderProductDetail = () =>
  render(
    <MemoryRouter initialEntries={['/product/p1']}>
      <Routes>
        <Route path="/product/:id" element={<ProductDetail />} />
        <Route path="/seller/:id" element={<div>seller page</div>} />
      </Routes>
    </MemoryRouter>
  );

const renderSellerProfile = () =>
  render(
    <MemoryRouter initialEntries={['/seller/s1']}>
      <Routes>
        <Route path="/seller/:id" element={<SellerProfile />} />
      </Routes>
    </MemoryRouter>
  );

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  }
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(productService.get).mockResolvedValue({ data: { product } });
  vi.mocked(productService.similar).mockResolvedValue({ data: { items: [] } });
  vi.mocked(productService.reviews).mockResolvedValue({
    data: {
      reviews: [reviewFixture],
      summary: { count: 1, average: 5 },
      canReview: { allowed: false, reason: 'purchase_required' },
    },
  });
  vi.mocked(productService.identityStatus).mockResolvedValue({ data: { tracked: false } });
  vi.mocked(favoriteService.check).mockResolvedValue({ data: { favorited: false } });
  vi.mocked(sellerService.trust).mockResolvedValue({
    data: { trust: { score: 80, level: 'trusted', breakdown: {} } },
  });
  vi.mocked(sellerService.review).mockResolvedValue({ data: { review: reviewFixture } });
});

afterEach(cleanup);

describe('Product reviews on the product page', () => {
  it('renders product reviews with their summary', async () => {
    renderProductDetail();

    expect(await screen.findByText('Vintage Camera')).toBeInTheDocument();
    expect(await screen.findByText('Exactly as described, fast shipping!')).toBeInTheDocument();
    expect(screen.getByText('Buyer Betty')).toBeInTheDocument();
    expect(screen.getByText('5 · 1 review')).toBeInTheDocument();
    // No review form — this user has no qualifying purchase
    expect(screen.queryByText('Review your purchase')).toBeNull();
  });

  it('shows the review form to a verified purchaser and submits it', async () => {
    vi.mocked(productService.reviews).mockResolvedValue({
      data: {
        reviews: [],
        summary: { count: 0, average: 0 },
        canReview: { allowed: true },
      },
    });

    const user = userEvent.setup();
    renderProductDetail();

    expect(await screen.findByText('Review your purchase')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Rate 4 stars'));
    await user.type(screen.getByPlaceholderText('How was the item and the seller?'), 'Great item');
    await user.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() =>
      expect(sellerService.review).toHaveBeenCalledWith('s1', {
        rating: 4,
        comment: 'Great item',
        product: 'p1',
      })
    );
    // Reviews are refreshed after submission
    await waitFor(() => expect(productService.reviews).toHaveBeenCalledTimes(2));
  });

  it('hides the review form for users without a qualifying purchase', async () => {
    renderProductDetail();

    expect(await screen.findByText('Exactly as described, fast shipping!')).toBeInTheDocument();
    expect(screen.queryByText('Review your purchase')).toBeNull();
  });

  it('keeps showing the existing seller trust display', async () => {
    renderProductDetail();

    expect(await screen.findByText('Vintage Camera')).toBeInTheDocument();
    // SellerInfo renders the trust level and badge from the trust service
    expect(await screen.findByText('trusted')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });
});

describe('Seller profile reviews (existing UI)', () => {
  it('still renders seller reviews', async () => {
    vi.mocked(sellerService.profile).mockResolvedValue({
      data: {
        seller: { _id: 's1', name: 'Seller Sam', createdAt: new Date().toISOString() },
        trust: { score: 80, level: 'trusted', breakdown: {} },
        products: [],
        reviews: [reviewFixture],
      },
    });

    renderSellerProfile();

    expect(await screen.findByText('Exactly as described, fast shipping!')).toBeInTheDocument();
    expect(screen.getByText('Buyer Betty')).toBeInTheDocument();
  });
});
