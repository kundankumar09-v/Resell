import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Search,
  Sparkles,
  ShieldCheck,
  MessageCircle,
  TrendingUp,
  Camera,
  Brain,
  Zap,
  ChevronRight,
  ArrowRight,
  Users,
  Award,
  Globe,
} from 'lucide-react';
import { productService, categoryService } from '../services/services';
import ProductCard from '../components/product/ProductCard';
import PageTransition from '../components/layout/PageTransition';
import { SkeletonGrid } from '../components/ui/Skeleton';
import Hero from '../components/layout/Hero';
import { ScrollReveal, RevealOnScroll } from '../components/ui/ScrollReveal';
import { TiltCard } from '../components/ui/TiltCard';
import MagneticButton from '../components/ui/MagneticButton';

const ICON_MAP = {
  smartphone: '📱',
  phone: '📱',
  laptop: '💻',
  shirt: '👕',
  home: '🏠',
  activity: '⚽',
  book: '📚',
  gamepad: '🎮',
  heart: '💖',
  truck: '🚗',
  package: '📦',
};

export default function Home() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    Promise.all([
      categoryService.list().catch(() => ({ data: { categories: [] } })),
      productService.list({ limit: 8, sort: 'popular' }).catch(() => ({ data: { items: [] } })),
    ]).then(([c, p]) => {
      setCategories(c.data.categories || []);
      setProducts(p.data.items || []);
      setLoading(false);
    });
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    if (search.trim()) navigate(`/marketplace?q=${encodeURIComponent(search)}`);
  };

  const features = [
    {
      icon: Brain,
      title: 'AI Price Recommendation',
      description: 'Get instant price suggestions based on market data, condition, and depreciation curves.',
      color: 'from-brand-500 to-brand-600',
      stats: '±5% accuracy',
    },
    {
      icon: Camera,
      title: 'Computer Vision',
      description: 'Automatic condition scoring, damage detection, and duplicate image protection.',
      color: 'from-accent-500 to-accent-600',
      stats: '95% precision',
    },
    {
      icon: ShieldCheck,
      title: 'Trust Score',
      description: 'Transparent seller ratings based on activity, reviews, and listing quality.',
      color: 'from-emerald-500 to-teal-500',
      stats: 'Real-time',
    },
    {
      icon: Zap,
      title: 'Fraud Detection',
      description: 'ML-powered risk assessment flags suspicious listings before they reach you.',
      color: 'from-amber-500 to-orange-500',
      stats: '24/7 monitoring',
    },
    {
      icon: MessageCircle,
      title: 'Real-time Chat',
      description: 'Connect with buyers and sellers instantly through Socket.io powered chat.',
      color: 'from-blue-500 to-cyan-500',
      stats: 'Sub-second',
    },
    {
      icon: TrendingUp,
      title: 'Similar Products',
      description: 'Discover alternatives using AI matching across categories, brands, and prices.',
      color: 'from-violet-500 to-purple-500',
      stats: 'Smart matching',
    },
  ];

  const trustIndicators = [
    { icon: ShieldCheck, label: 'Verified Sellers', desc: 'Identity & reputation verified' },
    { icon: Award, label: 'Secure Payments', desc: 'Escrow protection on all deals' },
    { icon: Globe, label: 'Global Reach', desc: 'Ship anywhere with confidence' },
    { icon: Users, label: 'Community Driven', desc: 'Real reviews from real buyers' },
  ];

  return (
    <PageTransition>
      {/* Hero Section */}
      <Hero />

      {/* Categories Section */}
      <section className="container-page py-16 md:py-24 relative z-10">
        <ScrollReveal direction="up">
          <div className="flex items-center justify-between mb-12">
            <div>
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="font-display font-bold text-3xl md:text-4xl mb-2"
              >
                Browse Categories
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 }}
                className="text-slate-500"
              >
                Explore items by category
              </motion.p>
            </div>
            <Link to="/marketplace" className="hidden sm:inline-flex items-center gap-2 text-brand-600 hover:underline font-medium text-sm">
              View all <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </ScrollReveal>

        {/* Category chips */}
        {categories.length > 0 && (
          <div className="flex snap-x gap-2 overflow-x-auto scrollbar-thin-x pb-4 mb-6 -mx-4 px-4 md:mx-0 md:px-0">
            <button
              onClick={() => navigate('/marketplace')}
              className="flex-shrink-0 snap-start rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-all hover:-translate-y-0.5 dark:bg-white dark:text-slate-900"
            >
              All
            </button>
            {categories.slice(0, 12).map((cat) => (
              <button
                key={`chip-${cat._id}`}
                onClick={() => navigate(`/marketplace?category=${cat._id}`)}
                className="flex-shrink-0 snap-start rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
              >
                <span className="mr-1.5">{ICON_MAP[cat.icon] || '📦'}</span>
                {cat.name}
              </button>
            ))}
          </div>
        )}

        <RevealOnScroll delay={0.1} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {categories.slice(0, 10).map((cat, i) => (
            <motion.button
              key={cat._id}
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              whileInView={{ opacity: 1, y: 0, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05, duration: 0.4 }}
              whileHover={{ y: -6, scale: 1.02 }}
              onClick={() => navigate(`/marketplace?category=${cat._id}`)}
              className="card p-6 text-center group hover:border-brand-300 hover:shadow-xl transition-all duration-300"
            >
              <motion.div
                className="text-5xl mb-3"
                whileHover={{ scale: 1.15, rotate: 6 }}
                transition={{ type: 'spring', stiffness: 400, damping: 17 }}
              >
                {ICON_MAP[cat.icon] || '📦'}
              </motion.div>
              <p className="font-medium text-sm text-slate-700">{cat.name}</p>
              <p className="text-xs text-slate-400 mt-1">{cat.productCount || 0} items</p>
            </motion.button>
          ))}
        </RevealOnScroll>
      </section>

      {/* Featured Products Section */}
      <section className="container-page py-16 md:py-24 relative z-10">
        <ScrollReveal direction="up">
          <div className="flex items-center justify-between mb-12">
            <div>
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="font-display font-bold text-3xl md:text-4xl mb-2"
              >
                Trending Now
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 }}
                className="text-slate-500"
              >
                Most popular items this week
              </motion.p>
            </div>
            <Link to="/marketplace?sort=popular" className="hidden sm:inline-flex items-center gap-2 text-brand-600 hover:underline font-medium text-sm">
              See more <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </ScrollReveal>

        <RevealOnScroll delay={0.1} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {loading ? (
            <SkeletonGrid count={8} />
          ) : products.length === 0 ? (
            <div className="col-span-full card p-12 text-center text-slate-500">
              No products available yet. Be the first to list something!
            </div>
          ) : (
            products.map((p, i) => (
              <ProductCard key={p._id} product={p} index={i} />
            ))
          )}
        </RevealOnScroll>
      </section>

      {/* Recommended — horizontal scroll-snap row */}
      {!loading && products.length > 0 && (
        <section className="py-8 md:py-12 relative z-10">
          <div className="container-page">
            <ScrollReveal direction="up">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="font-display font-bold text-2xl md:text-3xl mb-1">Recommended for you</h2>
                  <p className="text-slate-500 text-sm">Handpicked picks based on what's trending</p>
                </div>
                <Link to="/marketplace" className="hidden sm:inline-flex items-center gap-2 text-brand-600 hover:underline font-medium text-sm">
                  Browse all <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </ScrollReveal>
          </div>
          <div className="container-page">
            <div className="flex snap-x snap-mandatory gap-5 overflow-x-auto scrollbar-thin-x pb-4 -mx-4 px-4">
              {products.slice(0, 8).map((p, i) => (
                <div key={`rec-${p._id}`} className="w-[260px] flex-shrink-0 snap-start">
                  <ProductCard product={p} index={i} />
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Features Section */}
      <section className="container-page py-20 md:py-28 relative z-10">
        <ScrollReveal direction="up">
          <div className="text-center mb-16">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="font-display font-bold text-4xl md:text-5xl mb-4"
            >
              Why Choose <span className="gradient-text">ReSell</span>?
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              className="text-slate-600 max-w-2xl mx-auto text-lg"
            >
              Smart features that make buying and selling safer, faster, and more profitable.
            </motion.p>
          </div>
        </ScrollReveal>

        <RevealOnScroll delay={0.1} className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="group"
            >
              <TiltCard maxTilt={6} className="card p-6 h-full group-hover:shadow-2xl transition-all duration-500">
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-br ${f.color} grid place-items-center mb-4 group-hover:scale-110 transition-transform duration-300`}
                >
                  <f.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="font-display font-bold text-lg mb-2">{f.title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed mb-4">{f.description}</p>
                <div className="flex items-center gap-2 text-xs text-brand-600 font-medium">
                  <Zap className="w-3 h-3" />
                  {f.stats}
                </div>
              </TiltCard>
            </motion.div>
          ))}
        </RevealOnScroll>
      </section>

      {/* Trust Indicators */}
      <section className="container-page py-16 md:py-24 relative z-10">
        <ScrollReveal direction="up">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {trustIndicators.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="card p-6 text-center hover:shadow-xl hover:-translate-y-1 transition-all"
              >
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 grid place-items-center mx-auto mb-4">
                  <item.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="font-display font-bold text-lg mb-1">{item.label}</h3>
                <p className="text-sm text-slate-500">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </ScrollReveal>
      </section>

      {/* CTA Section */}
      <section className="container-page py-16 md:py-24 relative z-10">
        <ScrollReveal direction="up">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            className="card overflow-hidden bg-gradient-to-br from-brand-600 via-brand-500 to-accent-500 border-0 p-12 md:p-16 lg:p-20 text-center relative"
          >
            <div className="absolute inset-0 bg-grid opacity-10" />

            <div className="relative max-w-3xl mx-auto">
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="font-display font-extrabold text-4xl md:text-5xl lg:text-6xl text-white mb-6"
              >
                Ready to start selling?
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 }}
                className="text-white/90 text-lg mb-10 max-w-2xl mx-auto"
              >
                Join thousands of sellers using AI to list smarter and earn more.
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.2 }}
                className="flex flex-col sm:flex-row items-center justify-center gap-4"
              >
                <MagneticButton
                  as={Link}
                  to="/register"
                  className="inline-flex items-center gap-2 px-10 py-4 bg-white text-brand-700 font-semibold rounded-xl shadow-xl hover:shadow-2xl hover:-translate-y-0.5 transition-all"
                  strength={0.15}
                >
                  Get Started Free
                  <ChevronRight className="w-5 h-5" />
                </MagneticButton>
                <Link
                  to="/marketplace"
                  className="inline-flex items-center gap-2 px-10 py-4 bg-white/10 backdrop-blur border border-white/30 text-white font-semibold rounded-xl hover:bg-white/20 transition-all"
                >
                  Browse Marketplace
                  <ArrowRight className="w-5 h-5" />
                </Link>
              </motion.div>
            </div>
          </motion.div>
        </ScrollReveal>
      </section>
    </PageTransition>
  );
}