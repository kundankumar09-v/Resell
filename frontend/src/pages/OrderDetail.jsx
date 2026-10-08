import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Package,
  ArrowLeft,
  Clock,
  CheckCircle,
  Truck,
  XCircle,
  Undo2,
  Loader2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { orderService } from '../services/services';
import { formatDate, cn } from '../utils/format';
import useFormatPrice from '../hooks/useFormatPrice';
import { useAuth } from '../contexts/AuthContext';
import PageTransition from '../components/layout/PageTransition';
import Loader from '../components/ui/Loader';
import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../utils/imageFallback';

const STATUS_CONFIG = {
  pending_payment: { label: 'Awaiting Payment', icon: Clock, color: 'text-amber-500' },
  paid: { label: 'Paid', icon: CheckCircle, color: 'text-blue-500' },
  shipped: { label: 'Shipped', icon: Truck, color: 'text-purple-500' },
  delivered: { label: 'Delivered', icon: Package, color: 'text-emerald-500' },
  completed: { label: 'Completed', icon: CheckCircle, color: 'text-emerald-600' },
  payment_failed: { label: 'Payment Failed', icon: XCircle, color: 'text-red-500' },
  cancelled: { label: 'Cancelled', icon: XCircle, color: 'text-slate-400' },
  refunded: { label: 'Refunded', icon: XCircle, color: 'text-orange-500' },
};

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [tracking, setTracking] = useState('');

  const formatPrice = useFormatPrice(order?.currencyCode || 'USD');

  const load = useCallback(() => {
    setLoading(true);
    orderService
      .get(id)
      .then((r) => setOrder(r.data.order))
      .catch(() => {
        toast.error('Order not found');
        navigate('/orders');
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !order) return <Loader />;

  const cfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending_payment;
  const Icon = cfg.icon;
  const isBuyer = order.buyer?._id?.toString() === user?._id?.toString();
  const isSeller = order.seller?._id?.toString() === user?._id?.toString();
  const status = order.status;

  // Same role/status rules as the Orders list (mirrors the backend state machine)
  const showShip = isSeller && status === 'paid';
  const showDeliver = isBuyer && status === 'shipped';
  const showCancel = (isBuyer || isSeller) && (status === 'pending_payment' || status === 'paid');
  const isPaid = status === 'paid';

  const run = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMsg);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
    } finally {
      setBusy(false);
      setShipping(false);
    }
  };

  const handleCancel = () => {
    const message = isPaid
      ? 'Cancel this order? Your payment will be refunded via Stripe and the listing will be restored.'
      : 'Cancel this order?';
    if (!window.confirm(message)) return;
    run(() => orderService.cancel(order._id), isPaid ? 'Order cancelled — refund issued' : 'Order cancelled');
  };

  const platformFee = order.platformFee || 0;

  return (
    <PageTransition>
      <div className="container-page py-8 max-w-2xl mx-auto">
        <motion.button
          onClick={() => navigate('/orders')}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 mb-6"
          whileTap={{ scale: 0.95 }}
        >
          <ArrowLeft className="w-4 h-4" /> Back to Orders
        </motion.button>

        <h1 className="font-display text-2xl font-bold mb-1">Order #{order._id?.slice(-8).toUpperCase()}</h1>
        <div className="flex items-center gap-2 mb-6">
          <Icon className={`w-4 h-4 ${cfg.color}`} />
          <span className={`text-sm font-medium ${cfg.color}`}>{cfg.label}</span>
          <span className="text-xs text-slate-400">· placed {formatDate(order.createdAt)}</span>
        </div>

        <div className="card p-5 mb-4">
          <div className="flex items-start gap-4">
            <img
              src={order.product?.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
              alt=""
              className="w-24 h-24 rounded-xl object-cover border border-slate-100 bg-slate-50 flex-shrink-0"
              onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
            />
            <div className="flex-1 min-w-0">
              {order.product?._id ? (
                <Link to={`/product/${order.product._id}`} className="font-semibold hover:text-brand-600 line-clamp-2">
                  {order.product.title || 'Deleted listing'}
                </Link>
              ) : (
                <p className="font-semibold">{order.product?.title || 'Deleted listing'}</p>
              )}
              <p className="text-sm text-slate-500 mt-0.5">Buyer: {order.buyer?.name}</p>
              <p className="text-sm text-slate-500">Seller: {order.seller?.name}</p>
              {order.trackingNumber && (
                <p className="text-sm text-slate-600 mt-2 inline-flex items-center gap-1.5">
                  <Truck className="w-4 h-4" /> Tracking: {order.trackingNumber}
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-slate-100 mt-4 pt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Item price</span>
              <span>{formatPrice(order.salePrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Platform fee</span>
              <span>{formatPrice(platformFee)}</span>
            </div>
            <div className="flex justify-between font-semibold text-base border-t border-slate-100 pt-2">
              <span>Total</span>
              <span>{formatPrice(order.salePrice + platformFee)}</span>
            </div>
          </div>
        </div>

        {order.shippingAddress && (
          <div className="card p-4 mb-4">
            <p className="text-xs text-slate-500 mb-1">Shipping address</p>
            <p className="text-sm font-medium">{order.shippingAddress.fullName}</p>
            <p className="text-sm text-slate-600">
              {order.shippingAddress.line1}
              {order.shippingAddress.line2 ? `, ${order.shippingAddress.line2}` : ''},{' '}
              {order.shippingAddress.city}
              {order.shippingAddress.state ? `, ${order.shippingAddress.state}` : ''},{' '}
              {order.shippingAddress.country} {order.shippingAddress.postalCode}
            </p>
          </div>
        )}

        {Array.isArray(order.history) && order.history.length > 0 && (
          <div className="card p-4 mb-4">
            <p className="text-xs text-slate-500 mb-2">History</p>
            <div className="space-y-1.5">
              {order.history.map((h, i) => {
                const hCfg = STATUS_CONFIG[h.status] || STATUS_CONFIG.pending_payment;
                return (
                  <p key={i} className="text-sm text-slate-600 flex items-center gap-2">
                    <hCfg.icon className={`w-3.5 h-3.5 ${hCfg.color}`} />
                    <span className="capitalize">{h.status?.replace('_', ' ')}</span>
                    <span className="text-xs text-slate-400">· {formatDate(h.at)}</span>
                    {h.note && <span className="text-xs text-slate-400 truncate">— {h.note}</span>}
                  </p>
                );
              })}
            </div>
          </div>
        )}

        {(showShip || showDeliver || showCancel) && (
          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              {showDeliver && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => orderService.deliver(order._id), 'Delivery confirmed')}
                  className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <CheckCircle className="w-3.5 h-3.5" /> Confirm Delivery
                </button>
              )}
              {showShip && !shipping && (
                <button
                  type="button"
                  onClick={() => setShipping(true)}
                  className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1"
                >
                  <Truck className="w-3.5 h-3.5" /> Ship order
                </button>
              )}
              {showCancel && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleCancel}
                  className="text-xs px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  Cancel order{isPaid ? ' (refund)' : ''}
                </button>
              )}
            </div>

            {shipping && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={tracking}
                  onChange={(e) => setTracking(e.target.value)}
                  placeholder="Tracking number (optional)"
                  className="input text-sm max-w-[220px]"
                  autoFocus
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => orderService.ship(order._id, { trackingNumber: tracking }),
                      'Order shipped'
                    )
                  }
                  className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Truck className="w-3.5 h-3.5" />}
                  Confirm shipment
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShipping(false)}
                  className="text-xs px-2 py-1.5 text-slate-500 hover:text-slate-700"
                >
                  Back
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </PageTransition>
  );
}
