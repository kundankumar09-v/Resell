import { useEffect, useState, Fragment } from 'react';
import { motion } from 'framer-motion';
import { Search, Eye, Flag, CheckCircle, XCircle, AlertTriangle, ShieldCheck, ShieldAlert, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { adminService } from '../services/services';
import AdminLayout from '../components/admin/AdminLayout';
import Loader from '../components/ui/Loader';
import { formatDate } from '../utils/format';
import useFormatPrice from '../hooks/useFormatPrice';
import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../utils/imageFallback';

export default function AdminProducts() {
  const formatPrice = useFormatPrice('USD');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    load();
  }, [statusFilter, flagFilter]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await adminService.products({
        q: search,
        status: statusFilter,
        flagged: flagFilter === 'flagged' ? 'true' : undefined,
      });
      setItems(r.data.items);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    load();
  };

  const handleModerate = async (product, status) => {
    try {
      await adminService.moderateProduct(product._id, {
        status,
        isFlagged: status === 'active' ? false : product.isFlagged,
      });
      setItems((prev) =>
        prev.map((p) =>
          p._id === product._id
            ? { ...p, status, isFlagged: status === 'active' ? false : p.isFlagged }
            : p
        )
      );
      toast.success(`Listing ${status === 'active' ? 'approved & activated' : status}`);
    } catch {
      toast.error('Failed to update status');
    }
  };

  const handleFlag = async (product, isFlagged) => {
    try {
      await adminService.moderateProduct(product._id, {
        isFlagged,
        flagReason: isFlagged ? 'Flagged by admin' : '',
      });
      setItems((prev) =>
        prev.map((p) =>
          p._id === product._id
            ? { ...p, isFlagged, flagReason: isFlagged ? 'Flagged by admin' : '' }
            : p
        )
      );
      toast.success(isFlagged ? 'Listing flagged' : 'Flag removed');
    } catch {
      toast.error('Failed to update');
    }
  };

  const getRiskBadge = (score) => {
    if (score === null || score === undefined) return null;
    if (score >= 70) {
      return (
        <span className="badge bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 font-mono text-xs flex items-center gap-1">
          <ShieldAlert className="w-3 h-3" /> Risk: {score}/100
        </span>
      );
    }
    if (score >= 30) {
      return (
        <span className="badge bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-mono text-xs flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> Risk: {score}/100
        </span>
      );
    }
    return (
      <span className="badge bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-mono text-xs flex items-center gap-1">
        <ShieldCheck className="w-3 h-3" /> Safe: {score}/100
      </span>
    );
  };

  return (
    <AdminLayout title="Products">
      <div className="card p-4 mb-4 flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search listings..."
            className="input pl-9"
          />
        </form>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="input max-w-[200px]"
        >
          <option value="">All statuses</option>
          <option value="pendingReview">⚠️ Needs AI Review</option>
          <option value="active">Active</option>
          <option value="sold">Sold</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
          <option value="removed">Removed</option>
        </select>
        <select
          value={flagFilter}
          onChange={(e) => setFlagFilter(e.target.value)}
          className="input max-w-[160px]"
        >
          <option value="">All flags</option>
          <option value="flagged">Flagged only</option>
        </select>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <Loader />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="text-left p-3 font-medium text-sm">Listing</th>
                  <th className="text-left p-3 font-medium text-sm">Seller</th>
                  <th className="text-left p-3 font-medium text-sm">Price / Est.</th>
                  <th className="text-left p-3 font-medium text-sm">AI Risk & Status</th>
                  <th className="text-right p-3 font-medium text-sm">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((p) => (
                  <Fragment key={p._id}>
                  <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="p-3">
                      <div className="flex items-center gap-3">
                        <img
                          src={p.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
                          alt=""
                          className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                          onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
                        />
                        <div className="min-w-0">
                          <Link
                            to={`/product/${p._id}`}
                            className="font-medium text-sm hover:text-brand-600 line-clamp-1"
                          >
                            {p.title}
                          </Link>
                          <p className="text-xs text-slate-500">{p.category?.name || 'Uncategorized'}</p>
                          {p.fraudReasons && p.fraudReasons.length > 0 && (
                            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1 line-clamp-2">
                              🚩 {p.fraudReasons.join(' · ')}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-sm">
                      <div className="font-medium text-xs">{p.seller?.name || 'Unknown'}</div>
                      <div className="text-[11px] text-slate-500">{p.seller?.email}</div>
                    </td>
                    <td className="p-3 text-sm">
                      <div className="font-semibold">{formatPrice(p.price)}</div>
                      {p.suggestedPrice && (
                        <div className="text-[11px] text-brand-600 dark:text-brand-400 flex items-center gap-1">
                          <Sparkles className="w-2.5 h-2.5" /> Est: {formatPrice(p.suggestedPrice)}
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col gap-1 items-start">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`badge capitalize ${
                              p.status === 'active'
                                ? 'bg-emerald-100 text-emerald-700'
                                : p.status === 'sold'
                                ? 'bg-slate-100 text-slate-700'
                                : p.status === 'pendingReview'
                                ? 'bg-amber-100 text-amber-700 font-semibold'
                                : p.status === 'rejected'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {p.status === 'pendingReview' ? 'Needs Review' : p.status}
                          </span>
                          {p.isFlagged && (
                            <span className="badge bg-red-100 text-red-700 font-medium">Flagged</span>
                          )}
                        </div>
                        {getRiskBadge(p.fraudScore)}
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setExpandedId(expandedId === p._id ? null : p._id)}
                          title="Full AI Risk Detail"
                          className={`inline-flex p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${
                            expandedId === p._id
                              ? 'text-brand-600 dark:text-brand-400 bg-slate-100 dark:bg-slate-800'
                              : 'text-slate-400'
                          }`}
                        >
                          <ShieldCheck className="w-4 h-4" />
                        </button>
                        <Link
                          to={`/product/${p._id}`}
                          title="View Listing"
                          className="inline-flex p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"
                        >
                          <Eye className="w-4 h-4" />
                        </Link>
                        {p.status !== 'active' ? (
                          <button
                            onClick={() => handleModerate(p, 'active')}
                            title="Approve & Activate Listing"
                            className="inline-flex p-1.5 rounded hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-600"
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => handleModerate(p, 'rejected')}
                            title="Reject Listing"
                            className="inline-flex p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleFlag(p, !p.isFlagged)}
                          title={p.isFlagged ? 'Remove Flag' : 'Flag Listing'}
                          className={`inline-flex p-1.5 rounded hover:bg-amber-50 dark:hover:bg-amber-950/40 ${
                            p.isFlagged ? 'text-amber-600' : 'text-slate-400'
                          }`}
                        >
                          <Flag className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === p._id && (
                    <tr className="bg-slate-50 dark:bg-slate-800/30">
                      <td colSpan={5} className="p-3">
                        <div className="grid md:grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                              Full AI Risk Factors
                            </div>
                            {p.aiAnalysis?.riskAssessment?.factors?.length ? (
                              <ul className="space-y-1">
                                {p.aiAnalysis.riskAssessment.factors.map((f, i) => (
                                  <li key={i} className="text-xs text-slate-700 dark:text-slate-300 flex items-start gap-1.5">
                                    <span className="text-red-500 mt-0.5">•</span>
                                    {f}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-xs text-slate-500">No factors recorded.</p>
                            )}
                          </div>
                          <div>
                            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                              Risk Categories
                            </div>
                            {p.aiAnalysis?.riskAssessment?.riskFactorCategories?.length ? (
                              <div className="flex flex-wrap gap-1.5">
                                {p.aiAnalysis.riskAssessment.riskFactorCategories.map((cat) => (
                                  <span
                                    key={cat}
                                    className="badge bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-[11px]"
                                  >
                                    {cat}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-slate-500">No categories recorded.</p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {items.length === 0 && (
              <p className="text-center text-slate-500 py-8">No products found</p>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
