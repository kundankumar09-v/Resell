import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { ArrowLeftRight, Check, X, CornerUpLeft, Undo2, ArrowRight, CreditCard, Loader2 } from 'lucide-react';
import { offerService } from '../services/services';
import PageTransition from '../components/layout/PageTransition';
import EmptyState from '../components/ui/EmptyState';
import Loader from '../components/ui/Loader';
import { ScrollReveal } from '../components/ui/ScrollReveal';
import { formatPrice, formatDate, cn } from '../utils/format';
import { useAuth } from '../contexts/AuthContext';

import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../utils/imageFallback';

const STATUS_STYLES = {
  pending: { label: 'Pending', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  countered: { label: 'Countered', color: 'bg-violet-100 text-violet-700 border-violet-200' },
  accepted: { label: 'Accepted', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  withdrawn: { label: 'Withdrawn', color: 'bg-slate-100 text-slate-600 border-slate-200' },
  expired: { label: 'Expired', color: 'bg-slate-100 text-slate-600 border-slate-200' },
};

function OfferCard({ offer, mode, user, onAction }) {
  const [countering, setCountering] = useState(false);
  const [counterAmount, setCounterAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const status = STATUS_STYLES[offer.status] || STATUS_STYLES.pending;
  const isSeller = mode === 'received';
  const product = offer.product || {};
  const otherParty = isSeller ? offer.buyer : offer.seller;
  const canAct = offer.status === 'pending' || offer.status === 'countered';

  const run = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMsg);
      onAction();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
    } finally {
      setBusy(false);
      setCountering(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card p-4 sm:p-5 flex flex-col sm:flex-row gap-4"
    >
      <Link to={`/product/${product._id}`} className="shrink-0">
        <img
          src={product.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
          alt={product.title || 'Product'}
          className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl object-cover border border-slate-100 bg-slate-50"
          onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
        />
      </Link>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to={`/product/${product._id}`}
              className="font-semibold hover:text-brand-600 line-clamp-1"
            >
              {product.title || 'Deleted listing'}
            </Link>
            <p className="text-sm text-slate-500 mt-0.5">
              Listed at {formatPrice(product.price, offer.currencyCode || 'USD')}
            </p>
          </div>
          <span className={cn('shrink-0 text-xs font-medium px-2.5 py-1 rounded-full border', status.color)}>
            {status.label}
          </span>
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          <span className={cn('text-lg font-bold', offer.status === 'accepted' ? 'text-emerald-600' : 'text-slate-900')}>
            {formatPrice(offer.amount, offer.currencyCode || 'USD')}
          </span>
          <span className="text-xs text-slate-400">
            offer from {isSeller ? (otherParty?.name || 'buyer') : `you → ${otherParty?.name || 'seller'}`}
          </span>
        </div>

        {offer.message && (
          <p className="text-sm text-slate-500 italic mt-1 line-clamp-2">“{offer.message}”</p>
        )}
        <p className="text-xs text-slate-400 mt-1">{formatDate(offer.createdAt)}</p>

        {canAct && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isSeller && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => offerService.accept(offer._id), 'Offer accepted')}
                  className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" /> Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => offerService.reject(offer._id), 'Offer rejected')}
                  className="text-xs px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
                {offer.status === 'pending' && !countering && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setCountering(true)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <CornerUpLeft className="w-3.5 h-3.5" /> Counter
                  </button>
                )}
              </>
            )}
            {!isSeller && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => offerService.update(offer._id, { status: 'withdrawn' }), 'Offer withdrawn')}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-50"
              >
                <Undo2 className="w-3.5 h-3.5" /> Withdraw
              </button>
            )}
          </div>
        )}

        {!isSeller && offer.status === 'accepted' && product._id && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => navigate(`/checkout/${product._id}?offer=${offer._id}`)}
              className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1"
            >
              <CreditCard className="w-3.5 h-3.5" /> Pay {formatPrice(offer.amount, offer.currencyCode || 'USD')}
            </button>
          </div>
        )}

        {countering && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min="1"
              value={counterAmount}
              onChange={(e) => setCounterAmount(e.target.value)}
              placeholder="Your price"
              className="input text-sm max-w-[140px]"
              autoFocus
            />
            <button
              type="button"
              disabled={busy || !counterAmount || Number(counterAmount) <= 0}
              onClick={() =>
                run(
                  () => offerService.counter(offer._id, { amount: Number(counterAmount) }),
                  'Counter offer sent'
                )
              }
              className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Send counter
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setCountering(false)}
              className="text-xs px-2 py-1.5 text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export default function Offers() {
  const { user } = useAuth();
  const [tab, setTab] = useState('received');
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const fetcher = tab === 'received' ? offerService.received : offerService.mine;
    fetcher()
      .then((r) => setOffers(r.data.offers || []))
      .catch(() => toast.error('Failed to load offers'))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <PageTransition>
      <div className="container-page py-8 md:py-12">
        <ScrollReveal direction="up">
          <div className="mb-8">
            <h1 className="font-display font-bold text-3xl md:text-4xl mb-2 flex items-center gap-3">
              <ArrowLeftRight className="w-8 h-8 text-accent-500" />
              Offers
            </h1>
            <p className="text-slate-500">Negotiate deals — respond to offers you receive and track the ones you sent.</p>
          </div>
        </ScrollReveal>

        <div className="inline-flex rounded-xl bg-slate-100 p-1 mb-6">
          {[
            { key: 'received', label: 'Received' },
            { key: 'sent', label: 'Sent' },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <Loader />
        ) : offers.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title={tab === 'received' ? 'No offers received yet' : 'No offers sent yet'}
            description={
              tab === 'received'
                ? 'When buyers are interested in your listings, their offers will show up here'
                : 'Found something you like? Make an offer from the product page'
            }
            action={
              <a href="/marketplace" className="btn-primary inline-flex items-center gap-2">
                Browse Marketplace
                <ArrowRight className="w-4 h-4" />
              </a>
            }
          />
        ) : (
          <div className="space-y-4">
            {offers.map((offer) => (
              <OfferCard key={offer._id} offer={offer} mode={tab} user={user} onAction={load} />
            ))}
          </div>
        )}
      </div>
    </PageTransition>
  );
}
