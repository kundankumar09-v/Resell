import { useEffect, useState, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, SlidersHorizontal, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { productService, categoryService } from '../services/services';
import { useCurrency } from '../contexts/CurrencyContext';
import { convertPrice } from '../utils/currency';
import ProductCard from '../components/product/ProductCard';
import { SkeletonGrid } from '../components/ui/Skeleton';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import PageTransition from '../components/layout/PageTransition';
import { ScrollReveal, RevealOnScroll } from '../components/ui/ScrollReveal';
import MagneticButton from '../components/ui/MagneticButton';

// Map category icon names (from Category.icon) → emoji
const ICON_EMOJI = {
  smartphone: '📱',
  phone: '📱',
  laptop: '💻',
  computer: '🖥️',
  shirt: '👕',
  fashion: '👗',
  home: '🏠',
  garden: '🌿',
  activity: '🏋️',
  sports: '⚽',
  book: '📚',
  gamepad: '🎮',
  heart: '💄',
  beauty: '✨',
  truck: '🚗',
  car: '🚗',
  camera: '📷',
  music: '🎵',
  toy: '🧸',
};

const getCategoryEmoji = (cat) => {
  if (!cat) return '📦';
  const icon = (cat.icon || '').toLowerCase();
  if (ICON_EMOJI[icon]) return ICON_EMOJI[icon];
  // Try slug-based fallback
  const slug = (cat.slug || '').toLowerCase();
  for (const [key, emoji] of Object.entries(ICON_EMOJI)) {
    if (slug.includes(key)) return emoji;
  }
  return '📦';
};

export default function Marketplace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { currency, rates } = useCurrency();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoryStats, setCategoryStats] = useState([]);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const pillsRef = useRef(null);
  const [filters, setFilters] = useState({
    q: searchParams.get('q') || '',
    category: searchParams.get('category') || '',
    brand: searchParams.get('brand') || '',
    condition: searchParams.get('condition') || '',
    minPrice: searchParams.get('minPrice') || '',
    maxPrice: searchParams.get('maxPrice') || '',
    location: searchParams.get('location') || '',
    sort: searchParams.get('sort') || 'newest',
    page: 1,
  });
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });

  useEffect(() => {
    categoryService.list().then((r) => setCategories(r.data.categories)).catch(() => {});
    categoryService.stats().then((r) => setCategoryStats(r.data.stats || [])).catch(() => {});
    productService.brands().then((r) => setBrands(r.data.brands)).catch(() => {});
  }, []);

  // Merge categories with stats counts
  const categoriesWithCounts = useMemo(() => {
    const countMap = {};
    for (const s of categoryStats) {
      countMap[s._id] = s.count;
    }
    return categories.map((c) => ({ ...c, count: countMap[c._id] || 0 }));
  }, [categories, categoryStats]);

  const scrollPills = (dir) => {
    if (pillsRef.current) {
      pillsRef.current.scrollBy({ left: dir * 200, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    // Backend price filters compare canonical USD prices. Convert the user's
    // selected-currency input to USD before sending (never send INR/EUR/... raw).
    const toUsd = (v) => {
      if (!v) return '';
      const converted = convertPrice(Number(v), currency, 'USD', rates || {});
      return Number.isFinite(converted) ? String(Math.round(converted)) : '';
    };
    const apiParams = {
      ...filters,
      minPrice: toUsd(filters.minPrice),
      maxPrice: toUsd(filters.maxPrice),
    };
    productService
      .list(apiParams)
      .then((r) => {
        setProducts(r.data.items);
        setPagination(r.data.pagination);
      })
      .catch((err) => {
        const isNetwork = !err?.response;
        setLoadError(isNetwork ? 'network' : 'error');
      })
      .finally(() => setLoading(false));
  }, [filters, currency, rates]);

  const setFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  };

  const clearFilters = () => {
    setFilters({
      q: '',
      category: '',
      brand: '',
      condition: '',
      minPrice: '',
      maxPrice: '',
      location: '',
      sort: 'newest',
      page: 1,
    });
  };

  const activeFilterCount = useMemo(
    () =>
      ['category', 'brand', 'condition', 'minPrice', 'maxPrice', 'location'].filter(
        (k) => filters[k]
      ).length,
    [filters]
  );

  return (
    <PageTransition>
      <div className="relative">

        <div className="container-page py-8 md:py-12 relative z-10">
          {/* Header */}
          <ScrollReveal direction="up">
            <div className="mb-6">
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="font-display font-bold text-3xl md:text-4xl mb-2"
              >
                Marketplace
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="text-slate-500"
              >
                Discover unique items from verified sellers
              </motion.p>
            </div>
          </ScrollReveal>

          {/* ── Category pill row (OLX-style) ── */}
          <ScrollReveal delay={0.08} direction="up">
            <div className="relative mb-5">
              {/* Scroll arrows — desktop only */}
              <button
                onClick={() => scrollPills(-1)}
                className="hidden md:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 z-10 w-8 h-8 rounded-full bg-white border border-slate-200 shadow items-center justify-center hover:bg-slate-50 transition"
                aria-label="Scroll categories left"
              >
                <ChevronLeft className="w-4 h-4 text-slate-500" />
              </button>
              <div
                ref={pillsRef}
                className="flex gap-2 overflow-x-auto scrollbar-hide pb-1 md:px-4"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
              >
                {/* All Categories pill */}
                <motion.button
                  id="cat-pill-all"
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setFilter('category', '')}
                  className={`relative flex-shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition-all ${
                    !filters.category
                      ? 'border-brand-600 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50'
                  }`}
                >
                  {!filters.category && (
                    <motion.span
                      layoutId="active-cat-pill"
                      className="absolute inset-0 rounded-full bg-brand-600 shadow-md shadow-brand-500/25"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">All Categories</span>
                </motion.button>
                {categoriesWithCounts.map((cat) => (
                  <motion.button
                    key={cat._id}
                    id={`cat-pill-${cat.slug}`}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setFilter('category', cat._id)}
                    className={`relative flex-shrink-0 flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm font-medium transition-all ${
                      filters.category === cat._id
                        ? 'border-brand-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50'
                    }`}
                  >
                    {filters.category === cat._id && (
                      <motion.span
                        layoutId="active-cat-pill"
                        className="absolute inset-0 rounded-full bg-brand-600 shadow-md shadow-brand-500/25"
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-1.5">
                      <span>{getCategoryEmoji(cat)}</span>
                      <span>{cat.name}</span>
                      {cat.count > 0 && (
                        <span className={`text-xs ${filters.category === cat._id ? 'text-white/80' : 'text-slate-400'}`}>
                          {cat.count}
                        </span>
                      )}
                    </span>
                  </motion.button>
                ))}
              </div>
              <button
                onClick={() => scrollPills(1)}
                className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 z-10 w-8 h-8 rounded-full bg-white border border-slate-200 shadow items-center justify-center hover:bg-slate-50 transition"
                aria-label="Scroll categories right"
              >
                <ChevronRight className="w-4 h-4 text-slate-500" />
              </button>
            </div>
          </ScrollReveal>

          {/* ── Category tile grid (OLX-style icon grid) ── */}
          {!filters.category && categoriesWithCounts.length > 0 && (
            <ScrollReveal delay={0.12} direction="up">
              <div className="mb-6">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-8 xl:grid-cols-10 gap-3">
                  {categoriesWithCounts.map((cat, i) => (
                    <motion.button
                      key={cat._id}
                      id={`cat-tile-${cat.slug}`}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                      whileHover={{ y: -2, scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setFilter('category', cat._id)}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-2xl bg-white border border-slate-100 hover:border-brand-200 hover:bg-brand-50/40 shadow-sm hover:shadow-md transition-all group"
                    >
                      <span className="text-2xl group-hover:scale-110 transition-transform">{getCategoryEmoji(cat)}</span>
                      <span className="text-xs font-medium text-slate-700 text-center leading-tight line-clamp-2">{cat.name}</span>
                      {cat.count > 0 && (
                        <span className="text-[10px] text-slate-400 font-normal">{cat.count} listing{cat.count !== 1 ? 's' : ''}</span>
                      )}
                    </motion.button>
                  ))}
                </div>
              </div>
            </ScrollReveal>
          )}

          {/* Search & Filter Bar (sticky) */}
          <div className="sticky top-[76px] z-30 mb-6 rounded-2xl border border-slate-200/60 bg-white/85 px-3 py-3 shadow-soft-sm backdrop-blur-xl transition-all dark:border-white/10 dark:bg-slate-900/70">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  value={filters.q}
                  onChange={(e) => setFilter('q', e.target.value)}
                  placeholder="Search products..."
                  className="input pl-12"
                />
              </div>

              <div className="flex items-center gap-2">
                <MagneticButton
                  type="button"
                  onClick={() => setShowFilters((s) => !s)}
                  className="btn-secondary relative"
                  strength={0.15}
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">Filters</span>
                  {activeFilterCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-brand-500 text-white text-xs rounded-full grid place-items-center">
                      {activeFilterCount}
                    </span>
                  )}
                </MagneticButton>

                <select
                  value={filters.sort}
                  onChange={(e) => setFilter('sort', e.target.value)}
                  className="input max-w-[180px] hidden sm:block"
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="price-asc">Price: Low to High</option>
                  <option value="price-desc">Price: High to Low</option>
                  <option value="popular">Most Popular</option>
                </select>
              </div>
            </div>
          </div>

          {/* Filters Panel */}
          {showFilters && (
            <div
              onClick={() => setShowFilters(false)}
              aria-hidden="true"
              className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm md:hidden"
            />
          )}
          <AnimatePresence>
            {showFilters && (
              <ScrollReveal delay={0.2} direction="down">
                <motion.div
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 24 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 32 }}
                  className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto px-3 pb-4 md:static md:inset-auto md:z-auto md:mb-6 md:max-h-none md:overflow-visible md:px-0 md:pb-0"
                >
                  <div className="card p-5 rounded-b-none md:rounded-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-display font-semibold">Filters</h3>
                      <div className="flex items-center gap-3">
                        {activeFilterCount > 0 && (
                          <button
                            onClick={clearFilters}
                            className="text-sm text-slate-500 hover:text-red-600 flex items-center gap-1"
                          >
                            <X className="w-3 h-3" />
                            Clear all
                          </button>
                        )}
                        <button
                          onClick={() => setShowFilters(false)}
                          aria-label="Close filters"
                          className="md:hidden w-8 h-8 grid place-items-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 transition"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                      <select
                        value={filters.category}
                        onChange={(e) => setFilter('category', e.target.value)}
                        className="input"
                      >
                        <option value="">All categories</option>
                        {categories.map((c) => (
                          <option key={c._id} value={c._id}>{c.name}</option>
                        ))}
                      </select>
                      <select
                        value={filters.brand}
                        onChange={(e) => setFilter('brand', e.target.value)}
                        className="input"
                      >
                        <option value="">All brands</option>
                        {brands.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                      <select
                        value={filters.condition}
                        onChange={(e) => setFilter('condition', e.target.value)}
                        className="input"
                      >
                        <option value="">Any condition</option>
                        <option value="new">New</option>
                        <option value="like-new">Like New</option>
                        <option value="good">Good</option>
                        <option value="fair">Fair</option>
                        <option value="poor">Poor</option>
                      </select>
                      <input
                        type="number"
                        value={filters.minPrice}
                        onChange={(e) => setFilter('minPrice', e.target.value)}
                        placeholder="Min price"
                        className="input"
                      />
                      <input
                        type="number"
                        value={filters.maxPrice}
                        onChange={(e) => setFilter('maxPrice', e.target.value)}
                        placeholder="Max price"
                        className="input"
                      />
                      <input
                        type="text"
                        value={filters.location}
                        onChange={(e) => setFilter('location', e.target.value)}
                        placeholder="Location"
                        className="input"
                      />
                    </div>
                    <select
                      value={filters.sort}
                      onChange={(e) => setFilter('sort', e.target.value)}
                      className="input mt-3 sm:hidden"
                    >
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                      <option value="price-asc">Price: Low to High</option>
                      <option value="price-desc">Price: High to Low</option>
                      <option value="popular">Most Popular</option>
                    </select>
                  </div>
                </motion.div>
              </ScrollReveal>
            )}
          </AnimatePresence>

          {/* Results */}
          <ScrollReveal delay={showFilters ? 0.3 : 0.2} direction="up">
            <AnimatePresence mode="wait">
              {loading ? (
                <SkeletonGrid key="loading" count={8} />
              ) : loadError === 'network' ? (
                <ErrorState
                  key="network"
                  variant="network"
                  title="Connection lost"
                  description="We can't reach the marketplace right now. Check your internet and try again."
                  onRetry={() => setFilters((f) => ({ ...f }))}
                />
              ) : loadError === 'error' ? (
                <ErrorState
                  key="error"
                  title="Something went wrong"
                  description="We couldn't load this page."
                  onRetry={() => setFilters((f) => ({ ...f }))}
                />
              ) : products.length === 0 ? (
                <EmptyState
                  key="empty"
                  title={
                    filters.q
                      ? `No results for "${filters.q}"`
                      : 'No products found'
                  }
                  description={
                    filters.q
                      ? 'Try changing your search or removing some filters.'
                      : 'Try adjusting your filters or search query'
                  }
                  action={
                    <button onClick={clearFilters} className="btn-primary">
                      Clear filters
                    </button>
                  }
                />
              ) : (
                <>
                  <motion.p
                    key="count"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-sm text-slate-500 mb-4"
                  >
                    Showing {products.length} of {pagination.total} products
                  </motion.p>

                  <RevealOnScroll delay={0.05} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {products.map((p, i) => (
                      <ProductCard key={p._id} product={p} index={i} />
                    ))}
                  </RevealOnScroll>

                  {/* Pagination */}
                  {pagination.pages > 1 && (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-10 flex justify-center gap-2"
                    >
                      {Array.from({ length: pagination.pages }).map((_, i) => (
                        <motion.button
                          key={i}
                          onClick={() => setFilter('page', i + 1)}
                          whileTap={{ scale: 0.9 }}
                          className={`w-10 h-10 rounded-xl font-medium text-sm transition ${
                            filters.page === i + 1
                              ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/25'
                              : 'bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {i + 1}
                        </motion.button>
                      ))}
                    </motion.div>
                  )}
                </>
              )}
            </AnimatePresence>
          </ScrollReveal>
        </div>
      </div>
    </PageTransition>
  );
}
