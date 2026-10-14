import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useScroll,
} from 'framer-motion';
import { ArrowRight, ChevronDown, Sparkles, Search } from 'lucide-react';
import { productService } from '../../services/services';
import useFormatPrice from '../../hooks/useFormatPrice';
import { useAuth } from '../../contexts/AuthContext';

const HEADLINE_LINES = [
  ['Buy', 'less.'],
  ['Live', 'more.'],
  ['Resell', 'everything.'],
];

const CARD_STYLES = [
  { style: { top: '16%', left: '4%' }, baseRotate: -7, depth: 1.2, floatDuration: 6.5, delay: 0.35, size: 'w-44 xl:w-52' },
  { style: { top: '12%', right: '5%' }, baseRotate: 6, depth: 0.9, floatDuration: 7.6, delay: 0.5, size: 'w-40 xl:w-48' },
  { style: { bottom: '18%', left: '8%' }, baseRotate: 5, depth: 1.05, floatDuration: 8.2, delay: 0.65, size: 'w-40 xl:w-48' },
  { style: { bottom: '13%', right: '8%' }, baseRotate: -5, depth: 1.3, floatDuration: 7, delay: 0.8, size: 'w-44 xl:w-52' },
  { style: { top: '46%', left: '16%' }, xlOnly: true, baseRotate: 3, depth: 0.7, floatDuration: 9, delay: 0.95, size: 'w-36 xl:w-40' },
];

function useTrendingProducts(limit = CARD_STYLES.length) {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    let cancelled = false;
    productService
      .list({ limit, sort: 'popular' })
      .then((res) => {
        if (!cancelled) setProducts(res.data?.items || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [limit]);
  return products;
}

function AnimatedHeadline() {
  let wordIndex = 0;
  return (
    <h1 className="font-display font-extrabold tracking-tight leading-[1.04] text-slate-900 text-[clamp(3rem,8vw,6.5rem)]">
      {HEADLINE_LINES.map((line, li) => (
        <span key={li} className="block overflow-hidden pb-1">
          {line.map((word) => {
            const i = wordIndex++;
            const isGradient = word === 'Resell' || word === 'everything.';
            return (
              <motion.span
                key={i}
                className={`inline-block mr-[0.24em] last:mr-0 ${isGradient ? 'bg-clip-text text-transparent bg-gradient-to-r from-brand-600 via-violet-500 to-accent-500' : ''}`}
                initial={{ y: '110%', opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{
                  delay: 0.15 + i * 0.09,
                  duration: 0.7,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {word}
              </motion.span>
            );
          })}
        </span>
      ))}
    </h1>
  );
}

function FloatingProductCard({ product, style, index }) {
  const formatPrice = useFormatPrice();
  const img = product.images?.find((i) => i.isPrimary)?.url || product.images?.[0]?.url || 'data:image/svg+xml;charset=UTF-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'300\' viewBox=\'0 0 300 300\'%3E%3Crect width=\'300\' height=\'300\' fill=\'%23e2e8f0\'/%3E%3C/svg%3E';

  return (
    <motion.div
      className={`absolute z-10 hidden ${style.xlOnly ? 'xl:block' : 'lg:block'} ${style.size}`}
      style={style.style}
      initial={{ opacity: 0, scale: 0.6, y: 60 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{
        delay: style.delay,
        type: 'spring',
        stiffness: 90,
        damping: 14,
      }}
    >
      <MouseParallax depth={style.depth}>
        <motion.div
          animate={{
            y: [0, -16, 4, -10, 0],
            rotate: [style.baseRotate, style.baseRotate + 2, style.baseRotate - 1.5, style.baseRotate],
          }}
          transition={{
            duration: style.floatDuration,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: index * 0.7,
          }}
          whileHover={{ scale: 1.07, zIndex: 30 }}
          className="group cursor-pointer rounded-2xl border border-white/70 bg-white/75 shadow-[0_20px_50px_-15px_rgba(15,23,42,0.25)] backdrop-blur-xl will-change-transform"
        >
          <div className="relative h-28 xl:h-32 overflow-hidden rounded-t-2xl bg-slate-100">
            <img
              src={img}
              alt={product.title}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
              onError={(e) => {
                e.target.onerror = null;
                e.target.src = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%23e2e8f0'/%3E%3C/svg%3E";
              }}
            />
            {product.condition && (
              <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold capitalize text-brand-700 backdrop-blur">
                {product.condition.replace('-', ' ')}
              </span>
            )}
          </div>
          <div className="p-2.5">
            <p className="truncate text-[11px] font-medium text-slate-600">{product.title}</p>
            <p className="font-display text-base font-bold text-slate-900">{formatPrice(product.price)}</p>
          </div>
        </motion.div>
      </MouseParallax>
    </motion.div>
  );
}

const MouseContext = createContext(null);
export const MouseParallaxProvider = MouseContext.Provider;

function MouseParallax({ children, depth = 1 }) {
  const springs = useContext(MouseContext);
  const x = useTransform(springs.x, (v) => v * 34 * depth);
  const y = useTransform(springs.y, (v) => v * 26 * depth);
  return (
    <motion.div style={{ x, y }} className="will-change-transform">
      {children}
    </motion.div>
  );
}

export default function Hero() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const sectionRef = useRef(null);
  const formatPrice = useFormatPrice('USD');
  const trending = useTrendingProducts();
  const [query, setQuery] = useState('');

  const handleSearch = (e) => {
    e.preventDefault();
    if (query.trim()) navigate(`/marketplace?q=${encodeURIComponent(query.trim())}`);
  };

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 40, damping: 18 });
  const sy = useSpring(my, { stiffness: 40, damping: 18 });

  const handleMouseMove = (e) => {
    const rect = sectionRef.current?.getBoundingClientRect();
    if (!rect) return;
    mx.set((e.clientX - rect.left) / rect.width - 0.5);
    my.set((e.clientY - rect.top) / rect.height - 0.5);
  };

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end start'],
  });
  const contentY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  const contentOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);

  return (
    <section
      ref={sectionRef}
      onMouseMove={handleMouseMove}
      className="relative flex min-h-[100svh] w-full items-center justify-center overflow-hidden"
    >
      {/* Animated mesh-gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute inset-0 bg-mesh-gradient opacity-60" />
        <div className="ag-blob ag-blob-1" />
        <div className="ag-blob ag-blob-2" />
        <div className="ag-blob ag-blob-3" />
        <div className="absolute inset-0 bg-gradient-to-b from-white/10 via-white/40 to-slate-50 dark:from-transparent dark:via-transparent dark:to-transparent" />
      </div>

      <MouseParallaxProvider value={{ x: sx, y: sy }}>
        {/* Floating product cards around the hero (live trending items) */}
        {trending.map((p, i) => (
          <FloatingProductCard key={p._id} product={p} style={CARD_STYLES[i % CARD_STYLES.length]} index={i} />
        ))}

        {/* Center content */}
        <motion.div
          style={{ y: contentY, opacity: contentOpacity }}
          className="relative z-20 mx-auto flex max-w-4xl flex-col items-center px-4 pt-24 pb-16 text-center"
        >
          {/* Brand pill */}
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 py-1.5 pl-2 pr-4 shadow-sm backdrop-blur-xl"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-accent-500">
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </span>
            <span className="text-xs font-semibold tracking-wide text-slate-600">
              The AI-powered resale marketplace
            </span>
          </motion.div>

          <AnimatedHeadline />

          <motion.p
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.75, duration: 0.7, ease: 'easeOut' }}
            className="mt-7 max-w-xl text-balance text-lg text-slate-500 md:text-xl"
          >
            Give your items a second life. AI pricing, fraud detection, and trusted
            sellers — reselling has never felt this effortless.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.9, duration: 0.6, ease: 'easeOut' }}
            className="mt-10 flex flex-col items-center gap-4 sm:flex-row"
          >
            <Link
              to="/marketplace"
              className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full bg-slate-900 px-9 py-4 text-sm font-semibold text-white shadow-[0_16px_40px_-10px_rgba(15,23,42,0.45)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_20px_50px_-10px_rgba(79,74,240,0.55)] active:scale-95"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-brand-600 via-violet-500 to-accent-500 transition-transform duration-500 ease-out group-hover:translate-x-0" />
              <span className="relative">Explore Products</span>
              <ArrowRight className="relative h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </Link>

            {user?.role === 'buyer' ? (
              <Link
                to="/marketplace?sort=popular"
                className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-9 py-4 text-sm font-semibold text-slate-800 backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-300 hover:bg-white hover:shadow-[0_16px_40px_-14px_rgba(102,113,248,0.4)] active:scale-95"
              >
                Trending Deals
              </Link>
            ) : (
              <Link
                to="/sell"
                className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-9 py-4 text-sm font-semibold text-slate-800 backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-300 hover:bg-white hover:shadow-[0_16px_40px_-14px_rgba(102,113,248,0.4)] active:scale-95"
              >
                Sell an Item
              </Link>
            )}
          </motion.div>

          {/* Rounded-full hero search */}
          <motion.form
            onSubmit={handleSearch}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.0, duration: 0.6, ease: 'easeOut' }}
            className="mt-9 w-full max-w-xl"
          >
            <div className="group relative flex items-center rounded-full border border-white/70 bg-white/80 p-1.5 shadow-soft-lg backdrop-blur-xl transition-all duration-250 focus-within:border-brand-300 focus-within:shadow-glow dark:border-white/10 dark:bg-white/5">
              <Search className="ml-4 h-5 w-5 text-slate-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search for anything…"
                aria-label="Search marketplace"
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
              />
              <button
                type="submit"
                className="btn-primary rounded-full px-6 py-2.5"
              >
                Search
              </button>
            </div>
          </motion.form>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.15, duration: 0.8 }}
            className="mt-12 flex items-center gap-8 text-sm text-slate-400"
          >
            <div><span className="font-display font-bold text-slate-700">12k+</span> items resold</div>
            <div className="h-4 w-px bg-slate-200" />
            <div><span className="font-display font-bold text-slate-700">4.9★</span> trust rating</div>
            <div className="hidden h-4 w-px bg-slate-200 sm:block" />
            <div className="hidden sm:block"><span className="font-display font-bold text-slate-700">±5%</span> price accuracy</div>
          </motion.div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.6 }}
          className="absolute bottom-6 left-1/2 z-20 -translate-x-1/2"
        >
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            className="flex flex-col items-center gap-1 text-slate-400"
          >
            <span className="text-[10px] font-medium uppercase tracking-widest">Scroll</span>
            <ChevronDown className="h-4 w-4" />
          </motion.div>
        </motion.div>
      </MouseParallaxProvider>
    </section>
  );
}
