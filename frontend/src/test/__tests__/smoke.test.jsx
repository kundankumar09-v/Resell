import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Home from '../../pages/Home';
import Marketplace from '../../pages/Marketplace';
import Chat from '../../pages/Chat';
import ProductDetail from '../../pages/ProductDetail';
import { imageGuidanceFor, MIN_IMAGES, MAX_IMAGES, RECOMMENDED_IMAGES } from '../../utils/imageGuidance';

// Mock API calls globally
vi.mock('../../services/services', () => ({
  productService: {
    list: vi.fn().mockResolvedValue({ data: { items: [], pagination: { page: 1, pages: 1, total: 0 } } }),
    get: vi.fn().mockResolvedValue({ data: { product: { _id: '1', title: 'Test', price: 100, images: [], seller: { _id: '1', name: 'Seller' }, category: { name: 'Cat' } } } }),
    similar: vi.fn().mockResolvedValue({ data: { items: [] } }),
    brands: vi.fn().mockResolvedValue({ data: { brands: [] } }),
  },
  categoryService: {
    list: vi.fn().mockResolvedValue({ data: { categories: [] } }),
    stats: vi.fn().mockResolvedValue({ data: { stats: [] } }),
  },
  favoriteService: {
    check: vi.fn().mockResolvedValue({ data: { favorited: false } }),
    add: vi.fn(),
    remove: vi.fn(),
  },
  chatService: {
    conversations: vi.fn().mockResolvedValue({ data: { conversations: [] } }),
    messages: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    send: vi.fn(),
    markRead: vi.fn(),
    createConversation: vi.fn(),
  },
  sellerService: {
    trust: vi.fn().mockResolvedValue({ data: { trust: { score: 80, level: 'trusted' } } }),
  },
  reportService: { create: vi.fn() },
  offerService: { create: vi.fn() },
  notificationService: {
    list: vi.fn().mockResolvedValue({ data: { notifications: [] } }),
    unread: vi.fn().mockResolvedValue({ data: { count: 0 } }),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: '1' }) };
});

describe('SellProduct image guidance', () => {
  it('keeps the multi-angle image limits', () => {
    expect(MIN_IMAGES).toBe(3);
    expect(RECOMMENDED_IMAGES).toBe('4-6');
    expect(MAX_IMAGES).toBe(8);
  });

  it('provides category-specific guidance and a generic fallback', () => {
    expect(imageGuidanceFor('Digital Camera')).toContain('Lens / mount detail');
    expect(imageGuidanceFor('Phones')).toContain('Front of the phone (screen on)');
    expect(imageGuidanceFor('Miscellaneous')).toContain('Front / main view');
  });
});

describe('Smoke Tests — Pages render without crashing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Home page renders', async () => {
    renderWithProviders(<Home />);
    expect(document.body).toBeTruthy();
  });

  it('Marketplace page renders', async () => {
    renderWithProviders(<Marketplace />);
    expect(document.body).toBeTruthy();
  });

  it('Chat page renders', async () => {
    renderWithProviders(<Chat />);
    expect(document.body).toBeTruthy();
  });

  it('ProductDetail page renders', async () => {
    renderWithProviders(<ProductDetail />);
    expect(document.body).toBeTruthy();
  });
});
