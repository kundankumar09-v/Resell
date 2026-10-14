import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Heart, MapPin, ShieldCheck, Eye } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { favoriteService } from '../../services/services';
import { getConditionLabel, getConditionColor, cn } from '../../utils/format';
import { getProductImageUrl, handleImageError, PRODUCT_FALLBACK_IMAGE } from '../../utils/imageFallback';
import Price from '../ui/Price';
import toast from 'react-hot-toast';
import { TiltCard } from '../ui/TiltCard';

export default function ProductCard({ product, index = 0 }) {
  const { user } = useAuth();
  const [favorited, setFavorited] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user && product?._id) {
      favoriteService.check(product._id).then((r) => setFavorited(r.data.favorited)).catch(() => {});
    }
  }, [user, product?._id]);

  const toggleFavorite = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) {
      toast.error('Please log in to save items');
      return;
    }
    setBusy(true);
    try {
      if (favorited) {
        await favoriteService.remove(product._id);
        setFavorited(false);
        toast.success('Removed from favorites');
      } else {
        await favoriteService.add(product._id);
        setFavorited(true);
        toast.success('Added to favorites');
      }
    } catch (err) {
      toast.error('Could not update favorites');
    } finally {
      setBusy(false);
    }
  };

  const mainImage = getProductImageUrl(product);
  const sellerName = product.seller?.name || 'Seller';
  const conditionClass = getConditionColor(product.condition);

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: Math.min(index * 0.05, 0.5), duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <Link to={`/product/${product._id}`} className="block">
        <TiltCard maxTilt={8} className="card overflow-hidden group">
          <div className="relative aspect-square overflow-hidden bg-slate-100">
            <div className="h-full w-full transition-transform duration-[400ms] ease-out-soft group-hover:scale-105">
              <motion.img
                src={mainImage}
                alt={product.title}
                loading="lazy"
                className="w-full h-full object-cover"
                onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
                initial={{ scale: 1.05 }}
                animate={{ scale: 1 }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
                style={{
                  transformOrigin: 'center center',
                }}
              />
            </div>
            <motion.div
              className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent"
              initial={{ opacity: 0 }}
              whileHover={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            />

            {/* Condition badge */}
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.2 }}
              className="absolute top-3 left-3"
            >
              <span className={cn('badge border backdrop-blur-md bg-white/95', conditionClass)}>
                {getConditionLabel(product.condition)}
              </span>
            </motion.div>

            {/* Favorite button */}
            <motion.button
              onClick={toggleFavorite}
              disabled={busy}
              whileTap={{ scale: 0.9 }}
              whileHover={{ scale: 1.1 }}
              className="absolute top-3 right-3 w-9 h-9 rounded-full bg-white/95 backdrop-blur-md grid place-items-center shadow-lg transition-all"
            >
              <motion.div
                animate={{
                  scale: favorited ? 1 : 0.8,
                  rotate: favorited ? 0 : -180,
                }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              >
                <Heart
                  className={cn(
                    'w-4 h-4 transition-all',
                    favorited ? 'fill-accent-500 text-accent-500' : 'text-slate-500'
                  )}
                />
              </motion.div>
              {busy && (
                <motion.div
                  className="absolute inset-0 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"
                />
              )}
            </motion.button>

            {/* Quick view / views count */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="absolute bottom-3 left-3 right-3 flex items-center justify-between"
            >
              <span className="badge bg-white/95 backdrop-blur text-slate-700 flex items-center gap-1">
                <Eye className="w-3 h-3" />
                {product.views || 0}
              </span>
              {product.originalPrice > product.price && (
                <span className="badge bg-emerald-100 text-emerald-700">
                  Save {Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)}%
                </span>
              )}
            </motion.div>

            {/* Sold badge */}
            {product.status === 'sold' && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute inset-0 bg-slate-900/70 grid place-items-center"
              >
                <span className="badge bg-white text-slate-900 text-sm font-bold px-4 py-2">SOLD</span>
              </motion.div>
            )}

            {/* Pending Review / Flagged badge */}
            {(product.status === 'pendingReview' || product.status === 'flagged' || product.isFlagged) && product.status !== 'sold' && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs grid place-items-center p-3 text-center"
              >
                <div className="bg-amber-500/90 text-white rounded-xl px-3 py-1.5 text-xs font-semibold shadow-lg backdrop-blur-md flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Under AI Moderation Review</span>
                </div>
              </motion.div>
            )}
          </div>

          <div className="p-4 space-y-3">
            <motion.h3
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="font-semibold text-slate-900 line-clamp-2 text-sm leading-snug group-hover:text-brand-600 transition-colors"
            >
              {product.title}
            </motion.h3>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.35 }}
            >
              <Price
                amount={product.price}
                originalPrice={product.originalPrice}
                fromCurrency={product.currencyCode || 'USD'}
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-100"
            >
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                <span className="line-clamp-1 font-medium">{sellerName}</span>
              </div>
              {product.location?.city && (
                <div className="flex items-center gap-1.5 line-clamp-1">
                  <MapPin className="w-3.5 h-3.5" />
                  <span>{product.location.city}</span>
                </div>
              )}
            </motion.div>
          </div>
        </TiltCard>
      </Link>
    </motion.div>
  );
}