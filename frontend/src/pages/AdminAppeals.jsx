import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, ShieldQuestion } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminAppealService } from '../services/services';
import AdminLayout from '../components/admin/AdminLayout';
import Loader from '../components/ui/Loader';
import { formatDate } from '../utils/format';
import useFormatPrice from '../hooks/useFormatPrice';

export default function AdminAppeals() {
  const formatPrice = useFormatPrice('USD');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');

  useEffect(() => {
    load();
  }, [statusFilter]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await adminAppealService.list({
        status: statusFilter || undefined,
      });
      setItems(r.data.items);
    } finally {
      setLoading(false);
    }
  };

  const handleDecide = async (appeal, status) => {
    const note = window.prompt(
      `Optional note for the seller${status === 'approved' ? ' (approving clears the automated flag)' : ''}:`
    );
    if (note === null) return;
    try {
      await adminAppealService.decide(appeal._id, { status, moderatorNote: note || '' });
      toast.success(status === 'approved' ? 'Appeal approved — flag cleared' : 'Appeal rejected');
      load();
    } catch {
      toast.error('Failed to update appeal');
    }
  };

  return (
    <AdminLayout title="Flag Appeals">
      <div className="card p-4 mb-4 flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="input max-w-[200px]"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        <p className="text-xs text-slate-500">
          Sellers dispute automated fraud/quality flags here. Approving clears the flag.
        </p>
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
                  <th className="text-left p-3 font-medium text-sm">Reason</th>
                  <th className="text-left p-3 font-medium text-sm">Submitted</th>
                  <th className="text-left p-3 font-medium text-sm">Status</th>
                  <th className="text-right p-3 font-medium text-sm">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((a) => (
                  <motion.tr
                    key={a._id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <td className="p-3">
                      <div className="flex items-center gap-3 max-w-[260px]">
                        <ShieldQuestion className="w-4 h-4 text-brand-600 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium text-sm line-clamp-1">
                            {a.product?.title || '—'}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {a.product ? `${formatPrice(a.product.price)}` : ''}
                            {a.product?.flagReason ? ` · ${a.product.flagReason}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-xs">
                      <div className="font-medium">{a.seller?.name || 'Unknown'}</div>
                      <div className="text-slate-500">{a.seller?.email}</div>
                    </td>
                    <td className="p-3 text-xs text-slate-600 dark:text-slate-300 max-w-[280px]">
                      <p className="line-clamp-3">{a.reason}</p>
                    </td>
                    <td className="p-3 text-xs text-slate-500">{formatDate(a.createdAt)}</td>
                    <td className="p-3">
                      <span
                        className={`badge capitalize ${
                          a.status === 'approved'
                            ? 'bg-emerald-100 text-emerald-700'
                            : a.status === 'rejected'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {a.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      {a.status === 'pending' ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleDecide(a, 'approved')}
                            title="Approve — clear the automated flag"
                            className="inline-flex p-1.5 rounded hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-600"
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDecide(a, 'rejected')}
                            title="Reject — keep the flag"
                            className="inline-flex p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">
                          {a.decidedAt ? formatDate(a.decidedAt) : ''}
                          {a.moderatorNote ? ` · ${a.moderatorNote}` : ''}
                        </span>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && (
              <p className="text-center text-slate-500 py-8">No appeals found</p>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}