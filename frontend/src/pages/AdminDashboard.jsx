import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Users,
  Package,
  Flag,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ShoppingBag,
  MessageCircle,
} from 'lucide-react';
import { adminService } from '../services/services';
import AdminLayout from '../components/admin/AdminLayout';
import Loader from '../components/ui/Loader';
import { formatDate } from '../utils/format';
import useFormatPrice from '../hooks/useFormatPrice';
import { ScrollReveal, RevealOnScroll } from '../components/ui/ScrollReveal';
import { TiltCard } from '../components/ui/TiltCard';
import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../utils/imageFallback';

const ICONS = {
  totalUsers: Users,
  totalProducts: Package,
  pendingReports: Flag,
  totalRevenue: DollarSign,
};

export default function AdminDashboard() {
  const formatPrice = useFormatPrice('USD');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminService.stats().then((r) => setData(r.data)).finally(() => setLoading(false));
  }, []);

  if (loading) return <AdminLayout title="Dashboard"><Loader /></AdminLayout>;

  const stats = data?.stats || {};

  const statCards = [
    { label: 'Total Users', value: stats.totalUsers, change: stats.newUsersLast7Days, icon: Users, color: 'from-blue-500 to-cyan-500' },
    { label: 'Total Products', value: stats.totalProducts, change: stats.newProductsLast7Days, icon: Package, color: 'from-brand-500 to-brand-600' },
    { label: 'Active Listings', value: stats.activeProducts, icon: TrendingUp, color: 'from-emerald-500 to-teal-500' },
    { label: 'Pending Reports', value: stats.pendingReports, icon: Flag, color: 'from-amber-500 to-orange-500' },
    { label: 'Total Sales', value: stats.totalSales, icon: CheckCircle2, color: 'from-violet-500 to-purple-500' },
    { label: 'Total Revenue', value: formatPrice(stats.totalRevenue), icon: DollarSign, color: 'from-emerald-500 to-green-600' },
    { label: 'Sellers', value: stats.totalSellers, icon: Users, color: 'from-pink-500 to-rose-500' },
    { label: 'Reviews', value: stats.totalReviews, icon: Clock, color: 'from-indigo-500 to-blue-500' },
  ];

  return (
    <AdminLayout title="Dashboard">

      <ScrollReveal direction="up">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="font-display font-bold text-3xl mb-2">Dashboard</h1>
          <p className="text-slate-500">Overview of your marketplace performance</p>
        </motion.div>
      </ScrollReveal>

      {/* Stats Grid */}
      <RevealOnScroll delay={0.08} className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statCards.map((stat, i) => (
          <StatCard key={i} {...stat} delay={i * 0.05} />
        ))}
      </RevealOnScroll>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Recent Products */}
        <ScrollReveal direction="up">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="card p-6"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-bold text-lg">Recent Listings</h3>
              <span className="text-sm text-slate-500">{data.recentProducts?.length || 0} items</span>
            </div>
            <div className="space-y-3">
              {data.recentProducts?.slice(0, 5).map((p, i) => (
                <motion.div
                  key={p._id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors"
                >
                  <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0">
                    <img
                      src={p.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
                      onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{p.title}</p>
                    <p className="text-xs text-slate-500">
                      {p.seller?.name} · {p.category?.name}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-sm">{formatPrice(p.price)}</p>
                    <p className="text-xs text-slate-500">{formatDate(p.createdAt)}</p>
                  </div>
                </motion.div>
              ))}
              {data.recentProducts?.length === 0 && (
                <p className="text-sm text-slate-500 text-center py-4">No recent listings</p>
              )}
            </div>
          </motion.div>
        </ScrollReveal>

        {/* Flagged Products */}
        <ScrollReveal delay={0.1} direction="up">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="card p-6"
          >
            <h3 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Flagged Listings
            </h3>
            {data.flaggedProducts?.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">No flagged listings</p>
            ) : (
              <div className="space-y-3">
                {data.flaggedProducts?.slice(0, 5).map((p, i) => (
                  <motion.div
                    key={p._id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100"
                  >
                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0">
                      <img
                        src={p.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
                        onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{p.title}</p>
                      <p className="text-xs text-amber-700">{p.flagReason}</p>
                    </div>
                    <span className="badge bg-amber-100 text-amber-700">Flagged</span>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        </ScrollReveal>
      </div>

      {/* Quick Actions */}
      <ScrollReveal delay={0.2} direction="up">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8"
        >
          {[
            { label: 'Manage Users', icon: Users, href: '/admin/users', color: 'from-blue-500 to-cyan-500' },
            { label: 'All Products', icon: Package, href: '/admin/products', color: 'from-brand-500 to-brand-600' },
            { label: 'Reports', icon: Flag, href: '/admin/reports', color: 'from-amber-500 to-orange-500' },
            { label: 'Analytics', icon: TrendingUp, href: '/admin/analytics', color: 'from-violet-500 to-purple-500' },
          ].map((action, i) => (
            <motion.a
              key={action.label}
              href={action.href}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.05 }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="card p-5 text-center hover:shadow-xl hover:-translate-y-1 transition-all group"
            >
              <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${action.color} grid place-items-center mx-auto mb-3 group-hover:scale-110 transition-transform`}>
                <action.icon className="w-6 h-6 text-white" />
              </div>
              <p className="font-semibold text-sm">{action.label}</p>
            </motion.a>
          ))}
        </motion.div>
      </ScrollReveal>
    </AdminLayout>
  );
}

function StatCard({ label, value, change, icon: Icon, color, delay }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 0.1 + delay, type: 'spring', stiffness: 400, damping: 25 }}
      className="relative"
    >
      <TiltCard maxTilt={4} className="card p-5 h-full">
        <div className="flex items-start justify-between mb-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${color} grid place-items-center shadow-lg`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
          {change !== undefined && change !== null && (
            <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full font-medium">
              +{change} (7d)
            </span>
          )}
        </div>
        <p className="text-2xl font-display font-bold">{value}</p>
        <p className="text-xs text-slate-500 mt-1">{label}</p>
      </TiltCard>
    </motion.div>
  );
}
