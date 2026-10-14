import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  ShoppingBag,
  Heart,
  MessageCircle,
  Bell,
  User,
  LogOut,
  LayoutDashboard,
  Plus,
  Menu,
  X,
  Sparkles,
  ChevronDown,
  Tag,
  Shield,
  ArrowLeftRight,
  Package,
  Moon,
  Sun,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import { notificationService } from '../../services/services';
import { cn, formatRelativeTime } from '../../utils/format';
import MagneticButton from '../ui/MagneticButton';
import CurrencySelector from '../ui/CurrencySelector';
import { useTheme } from '../../contexts/ThemeContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { totalUnread, unreadNotifications, setUnreadNotifications } = useSocket() || {};
  const navigate = useNavigate();
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const navbarRef = useRef(null);

  const closeAll = useCallback(() => {
    setNotifOpen(false);
    setMenuOpen(false);
    setUserMenuOpen(false);
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 24);
    handler();
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);

  useEffect(() => {
    closeAll();
  }, [location.pathname, location.search, closeAll]);

  // Click outside to close all dropdowns
  useEffect(() => {
    const onClickOutside = (e) => {
      if (navbarRef.current && !navbarRef.current.contains(e.target)) {
        closeAll();
      }
    };
    const anyOpen = notifOpen || menuOpen || searchOpen || userMenuOpen;
    if (anyOpen) {
      document.addEventListener('mousedown', onClickOutside);
    }
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [notifOpen, menuOpen, searchOpen, userMenuOpen, closeAll]);

  // Escape to close overlays + body scroll lock for mobile menu / notifications
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        closeAll();
      }
    };
    const anyOpen = notifOpen || menuOpen || searchOpen || userMenuOpen;
    if (anyOpen) document.addEventListener('keydown', onKey);
    // lock scroll when mobile menu or notifications open on small screens
    if (notifOpen || menuOpen || searchOpen) {
      if (window.innerWidth < 992) document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [notifOpen, menuOpen, searchOpen, userMenuOpen, closeAll]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/marketplace?q=${encodeURIComponent(searchQuery)}`);
      setSearchOpen(false);
      setSearchQuery('');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  const loadNotifications = async () => {
    try {
      const res = await notificationService.list({ limit: 10 });
      setNotifications(res.data.notifications || []);
    } catch {}
  };

  const handleNotifClick = (e) => {
    e?.stopPropagation();
    setNotifOpen((s) => {
      const next = !s;
      if (next && !s) loadNotifications();
      return next;
    });
    setMenuOpen(false);
    setUserMenuOpen(false);
    setSearchOpen(false);
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationService.markAllRead();
      setUnreadNotifications(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {}
  };

  const handleNotificationClick = (notification) => {
    const { type, payload } = notification;
    closeAll();
    if (type === 'message' && payload?.conversationId) {
      navigate(`/chat/${payload.conversationId}`);
    } else if (type === 'offer' && payload?.productId) {
      navigate(`/product/${payload.productId}`);
    } else if (type === 'report_update' && payload?.reportId) {
      navigate(`/reports/${payload.reportId}`);
    }
  };

  const renderNotificationContent = (n) => {
    const { type, payload, createdAt } = n;
    const timeAgo = formatRelativeTime(createdAt);
    const sender = payload?.senderId;
    const senderName = sender?.name || 'Someone';
    const senderAvatar = sender?.avatar?.url;

    const getAvatar = () => (
      <div className="h-8 w-8 rounded-full flex-shrink-0 overflow-hidden bg-slate-100">
        {senderAvatar ? (
          <img src={senderAvatar} alt={senderName} className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full grid place-items-center bg-gradient-to-br from-brand-500 to-accent-500 text-white text-sm font-semibold">
            {senderName?.[0]?.toUpperCase() || '?'}
          </div>
        )}
      </div>
    );

    const getIcon = (icon, color) => (
      <div className={`h-8 w-8 rounded-full flex-shrink-0 flex items-center justify-center ${color}`}>
        <icon className="h-4 w-4 text-white" />
      </div>
    );

    switch (type) {
      case 'message': {
        const productTitle = payload?.productId?.title;
        return (
          <>
            {getAvatar()}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900">
                <span className="font-semibold">{senderName}</span> sent you a message
              </p>
              {productTitle && (
                <p className="text-xs text-slate-500 truncate">About: {productTitle}</p>
              )}
            </div>
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <MessageCircle className="h-3.5 w-3.5" />
              <span>{timeAgo}</span>
            </div>
          </>
        );
      }
      case 'offer': {
        const amount = payload?.offerId?.amount;
        const productTitle = payload?.offerId?.product?.title || payload?.productId?.title;
        return (
          <>
            {getIcon(Tag, 'bg-amber-500')}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900">
                <span className="font-semibold">{senderName}</span> made an offer
                {amount && <span className="text-brand-600 font-semibold ml-1">₹{Number(amount).toLocaleString()}</span>}
              </p>
              {productTitle && (
                <p className="text-xs text-slate-500 truncate">on <span className="font-medium">{productTitle}</span></p>
              )}
            </div>
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Tag className="h-3.5 w-3.5" />
              <span>{timeAgo}</span>
            </div>
          </>
        );
      }
      case 'report_update': {
        const status = payload?.reportId?.status;
        return (
          <>
            {getIcon(Shield, 'bg-blue-500')}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900">
                Report <span className="font-semibold capitalize">{status || 'updated'}</span>
              </p>
            </div>
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Shield className="h-3.5 w-3.5" />
              <span>{timeAgo}</span>
            </div>
          </>
        );
      }
      case 'admin_action': {
        return (
          <>
            {getIcon(Shield, 'bg-purple-500')}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900">Admin action taken</p>
            </div>
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Shield className="h-3.5 w-3.5" />
              <span>{timeAgo}</span>
            </div>
          </>
        );
      }
      default:
        return (
          <>
            {getIcon(Bell, 'bg-slate-500')}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900">New notification</p>
            </div>
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Bell className="h-3.5 w-3.5" />
              <span>{timeAgo}</span>
            </div>
          </>
        );
    }
  };

  const navLinks = [
    { to: '/marketplace', label: 'Browse', match: (s) => s.get('sort') !== 'popular' && s.get('sort') !== 'newest' },
    { to: '/marketplace?sort=popular', label: 'Trending', match: (s) => s.get('sort') === 'popular' },
    { to: '/marketplace?sort=newest', label: 'New Arrivals', match: (s) => s.get('sort') === 'newest' },
  ];

  return (
    <motion.header
      ref={navbarRef}
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4"
    >
      <div
        className={cn(
          'container-page rounded-2xl transition-all duration-500',
          scrolled
            ? 'navbar-shell-scrolled border border-white/60 bg-white/75 shadow-soft-md backdrop-blur-2xl'
            : 'border border-transparent bg-transparent'
        )}
      >
        <div className="flex items-center justify-between px-2 py-2.5 sm:px-3">
          {/* Logo */}
          <Link to="/" className="group relative z-10 flex items-center gap-2">
            <motion.div
              whileHover={{ rotate: 90, scale: 1.08 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-600 via-violet-500 to-accent-500 shadow-lg shadow-brand-500/30"
            >
              <Sparkles className="h-4 w-4 text-white" />
            </motion.div>
            <span className="font-display text-xl font-extrabold tracking-tight text-slate-900 md:text-2xl">
              Re<span className="gradient-text">Sell</span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="nav-links relative hidden items-center gap-0.5 lg:flex" role="navigation" aria-label="Main">
            {navLinks.map((link) => {
              const isActive =
                location.pathname + location.search === link.to ||
                (location.pathname === '/marketplace' && link.match(new URLSearchParams(location.search)));
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  className={cn(
                    'group relative rounded-full px-4 py-2 text-sm font-medium transition-colors duration-250',
                    isActive ? 'text-brand-700 dark:text-white' : 'text-slate-500 hover:text-slate-900'
                  )}
                >
                  <span className="relative z-10">{link.label}</span>
                  {isActive && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-3 bottom-0.5 z-0 h-[2px] rounded-full bg-gradient-to-r from-brand-600 via-violet-500 to-accent-500"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Search bar (desktop) */}
          <div className="mx-4 hidden max-w-xs flex-1 xl:block">
            <form onSubmit={handleSearch} className="relative w-full">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search anything..."
                className={cn(
                  'w-full rounded-xl border py-2 pl-10 pr-4 text-sm outline-none transition-all',
                  scrolled
                    ? 'border-slate-200 bg-slate-50/80 focus:border-brand-400 focus:bg-white'
                    : 'border-white/50 bg-white/60 backdrop-blur focus:border-brand-400 focus:bg-white'
                )}
              />
            </form>
          </div>

          {/* Right side actions */}
          <div className="flex items-center gap-1.5">
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                setSearchOpen(true);
                setNotifOpen(false);
                setMenuOpen(false);
                setUserMenuOpen(false);
              }}
              className="rounded-xl p-2 transition-colors hover:bg-white/70 xl:hidden min-h-[44px] min-w-[44px] grid place-items-center"
              aria-label="Search"
              whileTap={{ scale: 0.9 }}
            >
              <Search className="h-5 w-5 text-slate-600" />
            </motion.button>

            <div className="hidden sm:block">
              <CurrencySelector />
            </div>
            <motion.button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-pressed={theme === 'dark'}
              whileTap={{ scale: 0.88 }}
              whileHover={{ scale: 1.05 }}
              className="relative rounded-xl p-2 min-h-[44px] min-w-[44px] grid place-items-center hover:bg-white/70 dark:hover:bg-slate-800 transition-colors"
            >
              <AnimatePresence mode="wait" initial={false}>
                {theme === 'dark' ? (
                  <motion.div
                    key="sun"
                    initial={{ scale: 0.5, rotate: -90, opacity: 0 }}
                    animate={{ scale: 1, rotate: 0, opacity: 1 }}
                    exit={{ scale: 0.5, rotate: 90, opacity: 0 }}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                  >
                    <Sun className="h-5 w-5 text-amber-300 drop-shadow-[0_0_8px_rgba(252,211,77,0.5)]" />
                  </motion.div>
                ) : (
                  <motion.div
                    key="moon"
                    initial={{ scale: 0.5, rotate: 90, opacity: 0 }}
                    animate={{ scale: 1, rotate: 0, opacity: 1 }}
                    exit={{ scale: 0.5, rotate: -90, opacity: 0 }}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                  >
                    <Moon className="h-5 w-5 text-slate-600" />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.button>

            {user ? (
              <>
                {user.role !== 'buyer' && (
                  <MagneticButton
                    to="/sell"
                    strength={0.2}
                    className="hidden rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/15 transition-shadow hover:shadow-xl sm:inline-flex"
                  >
                    <Plus className="h-4 w-4" />
                    Sell
                  </MagneticButton>
                )}

                <IconLink to="/favorites" label="Favorites">
                  <Heart className="h-5 w-5 text-slate-600 transition-colors group-hover:text-accent-500" />
                </IconLink>

                <IconLink to="/offers" label="Offers">
                  <ArrowLeftRight className="h-5 w-5 text-slate-600 transition-colors group-hover:text-brand-600" />
                </IconLink>

                <IconLink to="/orders" label="My Orders">
                  <Package className="h-5 w-5 text-slate-600 transition-colors group-hover:text-brand-600" />
                </IconLink>

                <IconLink to="/chat" label="Messages" badge={totalUnread}>
                  <MessageCircle className="h-5 w-5 text-slate-600 transition-colors group-hover:text-brand-600" />
                </IconLink>

                <div className="relative">
                  <motion.button
                    onClick={handleNotifClick}
                    className="group relative hidden rounded-xl p-2 transition-colors hover:bg-white/70 sm:flex min-h-[44px] min-w-[44px] items-center justify-center"
                    whileTap={{ scale: 0.9 }}
                    aria-label="Notifications"
                    aria-expanded={notifOpen}
                    aria-haspopup="dialog"
                  >
                    <Bell className="h-5 w-5 text-slate-600 transition-colors group-hover:text-brand-600" />
                    {unreadNotifications > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold grid place-items-center leading-none">
                        {unreadNotifications > 99 ? '99+' : unreadNotifications}
                      </span>
                    )}
                  </motion.button>
                  {/* overlay for tablet/mobile notifications */}
                  {notifOpen && (
                    <div
                      className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
                      onClick={() => setNotifOpen(false)}
                      aria-hidden="true"
                    />
                  )}
                  <AnimatePresence>
                    {notifOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -8, scale: 0.96 }}
                        transition={{ duration: 0.18 }}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Notifications"
                        className="absolute right-0 mt-3 w-80 max-w-[92vw] origin-top-right overflow-hidden rounded-2xl border border-slate-200/70 bg-white/95 shadow-soft-lg backdrop-blur-2xl z-50 dark:border-slate-700/60 max-sm:fixed max-sm:inset-x-3 max-sm:top-20 max-sm:right-auto max-sm:left-auto"
                      >
                        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                          <p className="text-sm font-semibold text-slate-900">Notifications</p>
                          <div className="flex items-center gap-2">
                            {unreadNotifications > 0 && (
                              <button onClick={handleMarkAllRead} className="text-xs text-brand-600 hover:text-brand-700 font-medium min-h-[44px] px-2">
                                Mark all read
                              </button>
                            )}
                            <button onClick={() => setNotifOpen(false)} aria-label="Close notifications" className="min-h-[44px] min-w-[44px] grid place-items-center rounded-xl hover:bg-slate-100">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="max-h-80 overflow-y-auto overscroll-contain">
                          {notifications.length === 0 ? (
                            <p className="px-4 py-6 text-center text-sm text-slate-400">No notifications yet</p>
                          ) : (
                            notifications.map((n) => (
                              <div
                                key={n._id}
                                onClick={() => handleNotificationClick(n)}
                                className={`px-4 py-3 border-b border-slate-50 cursor-pointer transition-colors ${
                                  n.read ? 'text-slate-500 hover:bg-slate-50' : 'text-slate-900 bg-brand-50/30 hover:bg-brand-50/50'
                                }`}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => e.key === 'Enter' && handleNotificationClick(n)}
                              >
                                <div className="flex items-start gap-3">
                                  {renderNotificationContent(n)}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="relative">
                  <motion.button
                    onClick={(e) => {
                      e.stopPropagation();
                      setUserMenuOpen((s) => {
                        const next = !s;
                        if (next) {
                          setNotifOpen(false);
                          setMenuOpen(false);
                          setSearchOpen(false);
                        }
                        return next;
                      });
                    }}
                    className="flex items-center gap-1.5 rounded-full p-1 transition-colors hover:bg-white/70"
                    whileTap={{ scale: 0.95 }}
                    aria-label="Account menu"
                  >
                    {user.avatar?.url ? (
                      <img
                        src={user.avatar.url}
                        alt={user.name}
                        className="h-8 w-8 rounded-full object-cover shadow-md ring-2 ring-white"
                      />
                    ) : (
                      <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-semibold text-white">
                        {user.name?.[0]?.toUpperCase() || 'U'}
                      </div>
                    )}
                    <ChevronDown
                      className={cn('hidden h-4 w-4 text-slate-500 transition-transform sm:block', userMenuOpen && 'rotate-180')}
                    />
                  </motion.button>

                  <AnimatePresence>
                    {userMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -8, scale: 0.96 }}
                        transition={{ duration: 0.18 }}
                        className="absolute right-0 mt-3 w-56 origin-top-right overflow-hidden rounded-2xl border border-slate-200/70 bg-white/95 shadow-soft-lg backdrop-blur-2xl dark:border-slate-700/60"
                      >
                        <div className="border-b border-slate-100 p-4">
                          <p className="text-sm font-semibold text-slate-900">{user.name}</p>
                          <p className="truncate text-xs text-slate-500">{user.email}</p>
                        </div>
                        <div className="space-y-0.5 p-1.5">
                          {[
                            { to: '/profile', icon: User, label: 'Profile' },
                            ...(user.role !== 'buyer' ? [{ to: '/my-products', icon: ShoppingBag, label: 'My Listings' }] : []),
                            { to: '/favorites', icon: Heart, label: 'Favorites' },
                            { to: '/offers', icon: ArrowLeftRight, label: 'Offers' },
                            { to: '/orders', icon: Package, label: 'My Orders' },
                            { to: '/chat', icon: MessageCircle, label: 'Messages' },
                          ].map((item) => (
                            <Link
                              key={item.to}
                              to={item.to}
                              onClick={closeAll}
                              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                            >
                              <item.icon className="h-4 w-4" />
                              {item.label}
                            </Link>
                          ))}
                          {user.role === 'admin' && (
                            <Link
                              to="/admin/dashboard"
                              onClick={closeAll}
                              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                            >
                              <LayoutDashboard className="h-4 w-4" />
                              Admin Panel
                            </Link>
                          )}
                          <button
                            onClick={handleLogout}
                            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-red-600 transition-colors hover:bg-red-50"
                          >
                            <LogOut className="h-4 w-4" />
                            Logout
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </>
            ) : (
              <>
                <Link to="/login" className="hidden rounded-xl px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900 sm:inline-flex">
                  Log in
                </Link>
                <MagneticButton
                  to="/register"
                  strength={0.2}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/15 transition-shadow hover:shadow-xl"
                >
                  Sign up
                </MagneticButton>
              </>
            )}

            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((s) => {
                  const next = !s;
                  if (next) {
                    setNotifOpen(false);
                    setUserMenuOpen(false);
                    setSearchOpen(false);
                  }
                  return next;
                });
              }}
              className="rounded-xl p-2.5 transition-colors hover:bg-white/70 lg:hidden min-h-[44px] min-w-[44px] grid place-items-center"
              whileTap={{ scale: 0.9 }}
              aria-label="Menu"
              aria-expanded={menuOpen}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </motion.button>
          </div>
        </div>

        {/* Mobile menu */}
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="overflow-hidden lg:hidden"
            >
              <div className="space-y-1 border-t border-slate-100 py-3">
                {navLinks.map((link) => (
                  <Link
                    key={link.to}
                    to={link.to}
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-xl px-4 py-3 font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    {link.label}
                  </Link>
                ))}
                {user ? (
                  <>
                    {[
                      ...(user.role !== 'buyer' ? [
                        { to: '/sell', icon: Plus, label: 'Sell Item' },
                        { to: '/my-products', icon: ShoppingBag, label: 'My Listings' },
                      ] : []),
                      { to: '/favorites', icon: Heart, label: 'Favorites' },
                      { to: '/offers', icon: ArrowLeftRight, label: 'Offers' },
                      { to: '/orders', icon: Package, label: 'My Orders' },
                      { to: '/chat', icon: MessageCircle, label: 'Messages', badge: totalUnread },
                    ].map((item) => (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={() => setMenuOpen(false)}
                        className="flex items-center gap-3 rounded-xl px-4 py-3 font-medium text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        <div className="relative">
                          <item.icon className="h-5 w-5" />
                          {item.badge > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 rounded-full bg-brand-500 text-white text-[9px] font-bold grid place-items-center leading-none">
                              {item.badge > 99 ? '99+' : item.badge}
                            </span>
                          )}
                        </div>
                        {item.label}
                      </Link>
                    ))}
                    <div className="px-4 py-2 sm:hidden flex items-center justify-between border-t border-slate-100 dark:border-slate-800/80 pt-3">
                      <CurrencySelector compact />
                      <button
                        type="button"
                        onClick={toggleTheme}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                        aria-label="Toggle theme"
                      >
                        {theme === 'dark' ? (
                          <>
                            <Sun className="h-4 w-4 text-amber-400" />
                            <span>Light Mode</span>
                          </>
                        ) : (
                          <>
                            <Moon className="h-4 w-4 text-slate-600" />
                            <span>Dark Mode</span>
                          </>
                        )}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <Link
                      to="/login"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-xl px-4 py-3 font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      Log in
                    </Link>
                    <div className="px-4 py-2 sm:hidden flex items-center justify-between border-t border-slate-100 dark:border-slate-800/80 pt-3">
                      <CurrencySelector compact />
                      <button
                        type="button"
                        onClick={toggleTheme}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                        aria-label="Toggle theme"
                      >
                        {theme === 'dark' ? (
                          <>
                            <Sun className="h-4 w-4 text-amber-400" />
                            <span>Light Mode</span>
                          </>
                        ) : (
                          <>
                            <Moon className="h-4 w-4 text-slate-600" />
                            <span>Dark Mode</span>
                          </>
                        )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mobile search overlay */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setSearchOpen(false)}
          >
            <motion.div
              initial={{ y: -30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -30, opacity: 0 }}
              className="bg-white p-6 pt-8"
              onClick={(e) => e.stopPropagation()}
            >
              <form onSubmit={handleSearch} className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search anything..."
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 text-lg outline-none focus:border-brand-500"
                  />
                </div>
                <motion.button
                  type="button"
                  onClick={() => setSearchOpen(false)}
                  className="rounded-xl bg-slate-100 p-3 hover:bg-slate-200"
                  whileTap={{ scale: 0.9 }}
                  aria-label="Close search"
                >
                  <X className="h-5 w-5" />
                </motion.button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}

function IconLink({ to, label, children, badge }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className="group relative hidden rounded-xl p-2 transition-colors hover:bg-white/70 sm:flex min-h-[44px] min-w-[44px] items-center justify-center"
    >
      {children}
      {badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold grid place-items-center leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}
