import { motion } from 'framer-motion';
import { TrendingUp, Shield, AlertTriangle, Sparkles, Check, Info } from 'lucide-react';
import { getRiskColor, cn } from '../../utils/format';
import useFormatPrice from '../../hooks/useFormatPrice';

// Friendly labels for the generalized risk categories. The backend stores
// coarse categories (riskAssessment.riskFactorCategories) instead of the raw
// factor strings so internal detection thresholds are never exposed to
// buyers/sellers; admins see the full factors.
const RISK_CATEGORY_LABELS = {
  possible_duplicate_image: 'Photos match another listing',
  pricing_anomaly: 'Price is unusual for this item',
  account_risk: 'Seller account shows warning signs',
  identity_concern: 'Product identity / ownership needs review',
  content_quality: 'Listing quality needs review',
  other: 'Additional review recommended',
};

// Condition-score semantics (matches the backend contract):
//   0/absent = no visual evidence; 30-100 is the meaningful range
//   (100 = like-new, lower = worse).
const conditionEvidenceAvailable = (aiAnalysis) =>
  aiAnalysis?.visualAnalysisAvailable === true ||
  (typeof aiAnalysis?.conditionScore === 'number' && aiAnalysis.conditionScore > 0);

// Damage-score semantics: HIGHER means MORE damage. level is derived the
// same way as the backend (>= 50 high, >= 25 medium, else low).
const damageLevelOf = (score) => (score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low');

// Circular risk gauge (ring) — visualises riskScore out of 100.
function RiskRing({ score = 0, level = 'low' }) {
  const clamped = Math.max(0, Math.min(100, score));
  const R = 26;
  const C = 2 * Math.PI * R;
  const stroke =
    level === 'low' ? '#10b981' : level === 'medium' ? '#f59e0b' : '#f43f5e';
  return (
    <div className="relative h-16 w-16 flex-shrink-0" title={`Risk score ${clamped}/100`}>
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={R} fill="none" className="stroke-slate-200" strokeWidth="7" />
        <motion.circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke={stroke}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={C}
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C - (clamped / 100) * C }}
          transition={{ duration: 1, delay: 0.4, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{clamped}</span>
      </div>
    </div>
  );
}

export default function AIAnalysisPanel({ aiAnalysis, currencyCode }) {
  // Prices are displayed in the listing's currency (canonical backend value)
  const formatPrice = useFormatPrice(currencyCode || 'USD');

  if (!aiAnalysis) return null;
  const rec = aiAnalysis.priceRecommendation;
  const risk = aiAnalysis.riskAssessment;
  const conditionAvailable = conditionEvidenceAvailable(aiAnalysis);
  const damageAvailable =
    aiAnalysis?.visualAnalysisAvailable === true ||
    (typeof aiAnalysis?.damageScore === 'number' && aiAnalysis.damageScore > 0);
  const classification = aiAnalysis.classification;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="card p-6 space-y-6"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-600 to-accent-500 grid place-items-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="font-display font-bold text-lg">Trust &amp; AI Insights</h3>
            <p className="text-[11px] text-slate-500 -mt-0.5">Transparent, evidence-based signals</p>
          </div>
        </div>
        {risk && <RiskRing score={risk.riskScore || 0} level={risk.riskLevel} />}
      </div>

      {/* Price Recommendation — its own pricing confidence (evidence-based,
          from the backend's transparent multi-factor calculation) */}
      {rec && rec.recommendedPrice > 0 && (
        <div className="p-4 rounded-xl bg-gradient-to-br from-brand-50 to-accent-50 border border-brand-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-brand-600" />
              <span className="text-sm font-medium text-slate-700">Recommended Price</span>
            </div>
            <span className="badge bg-white border border-brand-200 text-brand-700">
              {Math.round((rec.confidence || 0) * 100)}% pricing confidence
            </span>
          </div>
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-3xl font-display font-bold gradient-text">
              {formatPrice(rec.recommendedPrice)}
            </span>
          </div>
          <div className="text-sm text-slate-600 mb-3">
            Range: <span className="font-medium">{formatPrice(rec.minPrice)}</span> —{' '}
            <span className="font-medium">{formatPrice(rec.maxPrice)}</span>
          </div>
          {rec.factors && rec.factors.length > 0 && (
            <ul className="space-y-1.5 text-xs text-slate-600">
              {rec.factors.slice(0, 4).map((f, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + i * 0.05 }}
                  className="flex items-start gap-2"
                >
                  <Check className="w-3 h-3 text-emerald-500 mt-0.5 flex-shrink-0" />
                  <span>{f}</span>
                </motion.li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Classification — its own confidence, clearly low when evidence is
          weak. Never presented as the confidence of the whole AI system. */}
      {classification?.predictedCategory && (
        <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-slate-600 mb-0.5">Predicted category</div>
            <div className="text-sm font-bold text-slate-900">
              {classification.predictedCategory}
            </div>
          </div>
          <span
            className={cn(
              'badge whitespace-nowrap',
              (classification.confidence || 0) >= 0.6
                ? 'bg-emerald-100 text-emerald-700'
                : (classification.confidence || 0) >= 0.4
                ? 'bg-amber-100 text-amber-700'
                : 'bg-slate-100 text-slate-500'
            )}
          >
            {Math.round((classification.confidence || 0) * 100)}% classification confidence
          </span>
        </div>
      )}

      {/* Condition + Damage — semantic labels, scores where useful, and an
          explicit "insufficient evidence" state instead of fake precision. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl bg-slate-50">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-medium text-slate-600">Visual condition</span>
            <span className="text-sm font-bold text-slate-900">
              {conditionAvailable ? `${aiAnalysis.conditionScore}/100` : '—'}
            </span>
          </div>
          {conditionAvailable ? (
            <>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${aiAnalysis.conditionScore}%` }}
                  transition={{ duration: 1, delay: 0.4 }}
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-500"
                />
              </div>
              <div className="text-[10px] text-slate-400 mt-1.5">
                Estimated from image quality · {Math.round((aiAnalysis.conditionConfidence ?? 0.65) * 100)}% confidence
              </div>
            </>
          ) : (
            <div className="text-[10px] text-slate-400 flex items-start gap-1">
              <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>Insufficient visual evidence for a condition estimate</span>
            </div>
          )}
        </div>
        <div className="p-3 rounded-xl bg-slate-50">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-medium text-slate-600">Damage</span>
            <span
              className={cn(
                'badge capitalize',
                !damageAvailable && 'bg-slate-100 text-slate-500',
                damageAvailable && damageLevelOf(aiAnalysis.damageScore) === 'low' && 'bg-emerald-100 text-emerald-700',
                damageAvailable && damageLevelOf(aiAnalysis.damageScore) === 'medium' && 'bg-amber-100 text-amber-700',
                damageAvailable && damageLevelOf(aiAnalysis.damageScore) === 'high' && 'bg-red-100 text-red-700'
              )}
            >
              {!damageAvailable
                ? 'No evidence'
                : damageLevelOf(aiAnalysis.damageScore) === 'low'
                ? 'Low'
                : damageLevelOf(aiAnalysis.damageScore) === 'medium'
                ? 'Moderate'
                : 'High'}
            </span>
          </div>
          {damageAvailable ? (
            <>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${aiAnalysis.damageScore}%` }}
                  transition={{ duration: 1, delay: 0.4 }}
                  className="h-full bg-gradient-to-r from-amber-500 to-red-500"
                />
              </div>
              <div className="text-[10px] text-slate-400 mt-1.5">
                {aiAnalysis.damageScore}/100 · higher means more damage · {Math.round((aiAnalysis.damageConfidence ?? 0.6) * 100)}% confidence
              </div>
            </>
          ) : (
            <div className="text-[10px] text-slate-400 flex items-start gap-1">
              <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>Insufficient visual evidence for a damage estimate</span>
            </div>
          )}
        </div>
      </div>

      {/* Risk Assessment — internal moderation signal, visible to the
          listing owner only (the API strips it for other viewers) */}
      {risk && (
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-slate-700" />
              <span className="text-sm font-medium text-slate-700">Risk Assessment</span>
            </div>
            <span className={cn('badge capitalize', getRiskColor(risk.riskLevel))}>
              {risk.riskLevel} risk
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${risk.riskScore || 0}%` }}
                transition={{ duration: 1, delay: 0.5 }}
                className={cn(
                  'h-full rounded-full',
                  risk.riskLevel === 'low' && 'bg-emerald-500',
                  risk.riskLevel === 'medium' && 'bg-amber-500',
                  risk.riskLevel === 'high' && 'bg-red-500'
                )}
              />
            </div>
            <span className="text-sm font-bold text-slate-900">{risk.riskScore || 0}/100</span>
          </div>
          {/* Owner-facing risk summary uses the generalized categories so
              internal detection thresholds (embedded in the raw factor
              strings) are never exposed. Admins see the full factors. */}
          {(risk.riskFactorCategories?.length > 0 || risk.factors?.length > 0) && (
            <div className="mt-3 space-y-1.5">
              {risk.riskFactorCategories && risk.riskFactorCategories.length > 0 ? (
                risk.riskFactorCategories.map((cat) => (
                  <div
                    key={cat}
                    className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg p-2"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{RISK_CATEGORY_LABELS[cat] || RISK_CATEGORY_LABELS.other}</span>
                  </div>
                ))
              ) : (
                <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg p-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{risk.factors[0]}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
