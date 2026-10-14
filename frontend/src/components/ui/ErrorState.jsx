import { motion } from 'framer-motion';
import { AlertCircle, WifiOff, RotateCw } from 'lucide-react';

function ErrorIllustration({ tone }) {
  return (
    <svg
      viewBox="0 0 240 160"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 mx-auto h-full w-full max-w-[240px]"
      fill="none"
    >
      <defs>
        <linearGradient id="error-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.35" />
          <stop offset="100%" stopColor={tone} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <ellipse cx="120" cy="138" rx="86" ry="12" fill={tone} opacity="0.10" />
      <circle cx="120" cy="70" r="46" fill="url(#error-grad)" />
      <circle cx="120" cy="70" r="46" stroke={tone} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="6 8" />
      <path d="M120 50v26" stroke={tone} strokeWidth="5" strokeLinecap="round" />
      <circle cx="120" cy="90" r="3.4" fill={tone} />
    </svg>
  );
}

export default function ErrorState({
  title = 'Something went wrong',
  description = "We couldn't load this page.",
  onRetry,
  variant = 'error',
}) {
  const isNetwork = variant === 'network';
  const Icon = isNetwork ? WifiOff : AlertCircle;
  const tone = isNetwork ? '#f59e0b' : '#f43f5e';
  const iconWrapClass = isNetwork
    ? 'from-amber-100 to-amber-50 ring-amber-200/60 dark:from-amber-500/25 dark:to-amber-500/5 dark:ring-amber-400/20'
    : 'from-danger-100 to-danger-50 ring-danger-200/60 dark:from-danger-500/25 dark:to-danger-500/5 dark:ring-danger-400/20';
  const iconClass = isNetwork ? 'text-amber-500' : 'text-danger-500';
  const ctaLabel = isNetwork ? 'Retry' : 'Try Again';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="relative text-center py-16 px-4"
      role="alert"
    >
      <div className="relative mx-auto mb-5 h-40 w-40">
        <ErrorIllustration tone={tone} />
        <div className={`relative z-10 inline-flex h-20 w-20 translate-y-10 items-center justify-center rounded-2xl bg-gradient-to-br ring-1 ${iconWrapClass}`}>
          <Icon className={`h-9 w-9 ${iconClass}`} />
        </div>
      </div>
      <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100 mb-2">{title}</h3>
      {description && <p className="text-slate-500 dark:text-slate-400 max-w-sm mx-auto mb-6">{description}</p>}
      {onRetry && (
        <button onClick={onRetry} className="btn-primary">
          <RotateCw className="h-4 w-4" />
          {ctaLabel}
        </button>
      )}
    </motion.div>
  );
}
