import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Package,
  ChevronRight,
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

function OrderCard({ order, mode, onAction }) {
  const [busy, setBusy] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [tracking, setTracking] = useState('');
  const formatPrice = useFormatPrice(order.currencyCode || 'USD');

  const cfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending_payment;
  const Icon = cfg.icon;
  const isSeller = mode === 'sales';
  const status = order.status;
  const otherParty = isSeller ? order.buyer : order.seller;

  // Role + status rules (mirrors the backend state machine)
  const showShip = isSeller && status === 'paid';
  const showDeliver = !isSeller && status === 'shipped';
  const showCancel = (isSeller || !isSeller) && (status === 'pending_payment' || status === 'paid');
  const isPaid = status === 'paid';

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
      setShipping(false);
    }
  };

  const handleCancel = () => {
    const message = isPaid
      ? 'Cancel this order? Your payment will be refunded via Stripe and the listing will be restored.'
      : 'Cancel this order?';
    if (!window.confirm(message)) return;
    run(
      () => orderService.cancel(order._id),
      isPaid ? 'Order cancelled — refund issued' : 'Order cancelled'
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex items-center gap-4">
        <img
          src={order.product?.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
          alt=""
          className="w-16 h-16 rounded-lg object-cover bg-slate-100 flex-shrink-0"
          onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
        />
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{order.product?.title}</p>
          <p className="text-sm text-slate-500">
            {isSeller ? 'Buyer' : 'Seller'}: {otherParty?.name}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
            <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
            <span className="text-xs text-slate-400">· {formatDate(order.createdAt)}</span>
          </div>
          {order.trackingNumber && (
            <p className="text-xs text-slate-500 mt-1 inline-flex items-center gap-1">
              <Truck className="w-3 h-3" /> Tracking: {order.trackingNumber}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="font-semibold">{formatPrice(order.salePrice)}</p>
          <Link
            to={`/orders/${order._id}`}
            className="text-xs text-brand-600 hover:underline flex items-center gap-1 mt-1"
          >
            Details <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {(showShip || showDeliver || showCancel) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
      )}

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
    </motion.div>
  );
}

export default function Orders() {
  const [tab, setTab] = useState('orders');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const fetcher = tab === 'orders' ? orderService.myOrders : orderService.mySales;
    fetcher()
      .then((r) => setOrders(r.data.orders || []))
      .catch(() => toast.error('Failed to load orders'))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <PageTransition>
      <div className="container-page py-8 max-w-3xl mx-auto">
        <h1 className="font-display text-2xl font-bold mb-6">Orders</h1>

        <div className="inline-flex rounded-xl bg-slate-100 p-1 mb-6">
          {[
            { key: 'orders', label: 'My Orders' },
            { key: 'sales', label: 'My Sales' },
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
        ) : orders.length === 0 ? (
          <div className="text-center py-16">
            <Package className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">
              {tab === 'orders' ? 'No orders yet' : 'No sales yet'}
            </p>
            <Link to="/marketplace" className="btn-primary mt-4 inline-flex">
              Browse Items
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order) => (
              <OrderCard key={order._id} order={order} mode={tab} onAction={load} />
            ))}
          </div>
        )}
      </div>
    </PageTransition>
  );
}
