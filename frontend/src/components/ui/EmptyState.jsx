import { motion } from 'framer-motion';
import { Package } from 'lucide-react';

/**
 * Illustration: a soft, theme-aware inline SVG backdrop for empty states.
 * Uses currentColor + brand/accent tokens so it reads well in light & dark.
 */
function EmptyIllustration() {
  return (
    <svg
      viewBox="0 0 240 160"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 mx-auto h-full w-full max-w-[240px] text-brand-500/25"
      fill="none"
    >
      <defs>
        <linearGradient id="empty-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="currentColor" />
          <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <ellipse cx="120" cy="138" rx="86" ry="12" fill="currentColor" opacity="0.10" />
      <circle cx="52" cy="44" r="7" className="fill-brand-400/30" />
      <circle cx="196" cy="34" r="5" className="fill-accent-400/40" />
      <circle cx="184" cy="112" r="4" className="fill-brand-300/40" />
      <rect x="72" y="52" width="96" height="66" rx="14" fill="url(#empty-grad)" opacity="0.5" />
      <rect x="86" y="40" width="68" height="30" rx="10" fill="currentColor" opacity="0.28" />
      <path
        d="M46 120 C 70 96, 96 108, 120 120 S 170 132, 194 112"
        stroke="url(#empty-grad)"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export default function EmptyState({ icon: Icon = Package, title, description, action }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative text-center py-16 px-4"
    >
      <div className="relative mx-auto mb-5 h-40 w-40">
        <EmptyIllustration />
        <motion.div
          animate={{ y: [0, -8, 0] }}
          transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
          className="relative z-10 inline-flex h-20 w-20 translate-y-10 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-100 to-accent-100 shadow-soft-md ring-1 ring-white/60 dark:from-brand-500/25 dark:to-accent-500/20 dark:ring-white/10"
        >
          <Icon className="h-9 w-9 text-brand-600 dark:text-brand-300" />
        </motion.div>
      </div>
      <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100 mb-2">{title}</h3>
      {description && (
        <p className="text-slate-500 dark:text-slate-400 max-w-sm mx-auto mb-6">{description}</p>
      )}
      {action}
    </motion.div>
  );
}
