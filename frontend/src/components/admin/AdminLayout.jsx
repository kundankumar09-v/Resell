import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Package,
  Flag,
  ShieldQuestion,
  TrendingUp,
  Tag,
  LogOut,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { cn } from '../../utils/format';
import { motion } from 'framer-motion';

const NAV = [
  { to: '/admin/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/admin/users', icon: Users, label: 'Users' },
  { to: '/admin/products', icon: Package, label: 'Products' },
  { to: '/admin/appeals', icon: ShieldQuestion, label: 'Flag Appeals' },
  { to: '/admin/reports', icon: Flag, label: 'Reports' },
  { to: '/admin/analytics', icon: TrendingUp, label: 'Analytics' },
  { to: '/admin/categories', icon: Tag, label: 'Categories' },
];

export default function AdminLayout({ children, title }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <motion.aside
        initial={{ x: -300 }}
        animate={{ x: 0 }}
        className="w-64 bg-white border-r border-slate-200 flex flex-col fixed h-screen z-40 shadow-soft-lg"
      >
        <Link to="/" className="flex items-center gap-2 p-6 border-b border-slate-200">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-600 to-accent-500 grid place-items-center shadow-pop">
            <span className="text-white font-bold">R</span>
          </div>
          <div>
            <span className="font-display font-extrabold">ReSell</span>
            <p className="text-xs text-slate-500">Admin Panel</p>
          </div>
        </Link>

        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((item, i) => {
            const Icon = item.icon;
            const active = location.pathname === item.to;
            return (
              <motion.Link
                key={item.to}
                to={item.to}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                whileHover={{ x: 4 }}
                className={cn(
                  'relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition',
                  active
                    ? 'bg-brand-50 text-brand-700 shadow-soft-sm'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                )}
              >
                {active && (
                  <motion.span
                    layoutId="admin-nav-active"
                    className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-gradient-to-b from-brand-500 to-accent-500"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
                <Icon className="w-4 h-4" />
                {item.label}
                {active && <ChevronRight className="w-4 h-4 ml-auto" />}
              </motion.Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex items-center gap-2 p-2 mb-1"
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 grid place-items-center text-white text-sm font-bold">
              {user?.name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.name}</p>
              <p className="text-xs text-slate-500 truncate">{user?.email}</p>
            </div>
          </motion.div>
          <motion.button
            onClick={handleLogout}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            whileHover={{ x: 4 }}
            whileTap={{ scale: 0.98 }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 transition"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </motion.button>
        </div>
      </motion.aside>

      {/* Main */}
      <motion.main
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        className="flex-1 ml-64"
      >
        <div className="p-8">
          {title && (
            <div className="mb-6">
              <motion.p
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs font-medium uppercase tracking-wider text-slate-400 mb-1"
              >
                Admin / {title}
              </motion.p>
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="font-display font-bold text-3xl"
              >
                {title}
              </motion.h1>
              <motion.span
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                style={{ originX: 0 }}
                transition={{ delay: 0.15, duration: 0.4, ease: 'easeOut' }}
                className="mt-3 block h-1 w-16 rounded-full bg-gradient-to-r from-brand-500 to-accent-500"
              />
            </div>
          )}
          {children}
        </div>
      </motion.main>
    </div>
  );
}