import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Plus,
  Edit3,
  Trash2,
  Eye,
  Tag,
  CheckCircle,
  XCircle,
  AlertTriangle,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { productService, appealService } from '../services/services';
import PageTransition from '../components/layout/PageTransition';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';
import { formatDate, cn } from '../utils/format';
import useFormatPrice from '../hooks/useFormatPrice';
import { ScrollReveal, RevealOnScroll } from '../components/ui/ScrollReveal';
import MagneticButton from '../components/ui/MagneticButton';
import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../utils/imageFallback';

export default function MyProducts() {
  const formatPrice = useFormatPrice('USD');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [appealTarget, setAppealTarget] = useState(null);

  useEffect(() => {
    productService
      .my()
      .then((r) => setItems(r.data.items))
      .finally(() => setLoading(false));
  }, []);

  const submitAppeal = async (productId, reason) => {
    try {
      await appealService.create(productId, { reason });
      toast.success('Appeal submitted for review');
      setAppealTarget(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to submit appeal');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this listing? This action cannot be undone.')) return;
    try {
      await productService.delete(id);
      setItems((prev) => prev.filter((p) => p._id !== id));
      toast.success('Listing deleted');
    } catch {
      toast.error('Failed to delete');
    }
  };

  const handleMarkSold = async (id) => {
    try {
      await productService.markSold(id);
      setItems((prev) =>
        prev.map((p) => (p._id === id ? { ...p, status: p.status === 'sold' ? 'active' : 'sold' } : p))
      );
      toast.success('Listing updated');
    } catch {
      toast.error('Failed to update');
    }
  };

  if (loading) return <Loader />;

  return (
    <PageTransition>
      <div className="relative">

        <div className="container-page py-8 md:py-12 relative z-10">
          <ScrollReveal direction="up">
            <div className="flex items-center justify-between mb-10">
              <div>
                <motion.h1
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="font-display font-bold text-3xl md:text-4xl mb-2"
                >
                  My Listings
                </motion.h1>
                <motion.p
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-slate-500"
                >
                  {items.length} total listing{items.length !== 1 && 's'}
                </motion.p>
              </div>
              <motion.Link
                to="/sell"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="btn-primary"
              >
                <Plus className="w-4 h-4" />
                New Listing
              </motion.Link>
            </div>
          </ScrollReveal>

          {items.length === 0 ? (
            <ScrollReveal delay={0.2} direction="up">
              <EmptyState
                title="No listings yet"
                description="Create your first listing to start selling"
                action={
                  <Link to="/sell" className="btn-primary">
                    <Plus className="w-4 h-4" />
                    Create Listing
                  </Link>
                }
              />
            </ScrollReveal>
          ) : (
            <RevealOnScroll delay={0.1} className="space-y-3">
              {items.map((p, i) => (
                <motion.div
                  key={p._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="card p-4 flex flex-col sm:flex-row gap-4 hover:shadow-xl transition-all"
                >
                  <Link
                    to={`/product/${p._id}`}
                    className="flex-shrink-0 w-full sm:w-32 h-32 rounded-xl overflow-hidden bg-slate-100"
                  >
                    <img
                      src={p.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
                      onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </Link>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <Link
                        to={`/product/${p._id}`}
                        className="font-semibold hover:text-brand-600 line-clamp-1"
                      >
                        {p.title}
                      </Link>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {p.status === 'pendingReview' ? (
                          <span className="badge bg-amber-100 text-amber-700 font-medium">
                            AI Review Needed
                          </span>
                        ) : (
                          <span
                            className={cn(
                              'badge',
                              p.status === 'active' && 'bg-emerald-100 text-emerald-700',
                              p.status === 'sold' && 'bg-slate-100 text-slate-700',
                              p.status === 'pending' && 'bg-amber-100 text-amber-700',
                              p.status === 'rejected' && 'bg-red-100 text-red-700'
                            )}
                          >
                            {p.status}
                          </span>
                        )}
                        {p.isFlagged && (
                          <button
                            type="button"
                            onClick={() => setAppealTarget(p)}
                            className="badge bg-red-100 text-red-700 hover:bg-red-200 font-medium"
                            title="Dispute this automated flag"
                          >
                            Flagged — Dispute
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-sm text-slate-500 line-clamp-1 mb-2">{p.description}</p>

                    {(p.status === 'pendingReview' || (p.fraudReasons && p.fraudReasons.length > 0)) && (
                      <div className="mb-3 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>
                          <strong className="font-semibold">AI Security Flag:</strong>{' '}
                          {p.fraudReasons?.join(' · ') || 'Under automatic fraud & quality review'}
                          {p.fraudScore !== undefined && p.fraudScore !== null ? ` (Risk: ${p.fraudScore}/100)` : ''}
                        </span>
                      </div>
                    )}

                    <div className="flex items-center gap-3 mb-3">
                      <span className="font-display font-bold text-lg">
                        {formatPrice(p.price)}
                      </span>
                      {p.suggestedPrice && (
                        <span className="text-xs text-brand-600 dark:text-brand-400 bg-brand-500/10 px-2 py-0.5 rounded-full">
                          AI Est: {formatPrice(p.suggestedPrice)}
                        </span>
                      )}
                      {p.views > 0 && (
                        <span className="text-xs text-slate-500 flex items-center gap-1">
                          <Eye className="w-3 h-3" /> {p.views}
                        </span>
                      )}
                      <span className="text-xs text-slate-500">
                        Listed {formatDate(p.createdAt)}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <motion.button
                        onClick={() => handleMarkSold(p._id)}
                        whileTap={{ scale: 0.97 }}
                        className="btn-secondary text-xs"
                      >
                        {p.status === 'sold' ? (
                          <>
                            <XCircle className="w-3 h-3" />
                            Mark as Active
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-3 h-3" />
                            Mark as Sold
                          </>
                        )}
                      </motion.button>
                      <Link to={`/edit/${p._id}`} className="btn-secondary text-xs">
                        <Edit3 className="w-3 h-3" />
                        Edit
                      </Link>
                      <motion.button
                        onClick={() => handleDelete(p._id)}
                        whileTap={{ scale: 0.97 }}
                        className="btn text-xs text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </motion.button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </RevealOnScroll>
          )}
        </div>
      </div>
      {appealTarget && (
        <AppealModal
          product={appealTarget}
          onClose={() => setAppealTarget(null)}
          onSubmit={(reason) => submitAppeal(appealTarget._id, reason)}
        />
      )}
    </PageTransition>
  );
}

function AppealModal({ product, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 grid place-items-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="card p-6 w-full max-w-md"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-bold text-xl">Dispute Automatic Flag</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-3">
          Explain why this listing should not be flagged. An admin will review
          your dispute.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSending(true);
            onSubmit(reason);
          }}
          className="space-y-3"
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            rows={4}
            maxLength={2000}
            placeholder="e.g. This is my original item — the photo matching is coincidental because..."
            className="input"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn">
              Cancel
            </button>
            <button type="submit" disabled={sending || !reason.trim()} className="btn-primary">
              {sending ? 'Submitting…' : 'Submit Dispute'}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
