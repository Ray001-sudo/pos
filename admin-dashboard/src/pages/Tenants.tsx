// =============================================================================
// src/pages/Tenants.tsx — Paginated tenant list with search and status filter
// =============================================================================
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Plus, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';

const STATUS_BADGE: Record<string, string> = {
    active:          'bg-green-100 text-green-800',
    past_due:        'bg-amber-100 text-amber-800',
    suspended:       'bg-red-100 text-red-800',
    offline_timeout: 'bg-gray-100 text-gray-800',
    cancelled:       'bg-gray-200 text-gray-600'
};

interface Tenant {
    tenant_id:            string;
    business_name:        string;
    business_category:    string;
    owner_email:          string;
    account_status:       string;
    days_overdue:         number;
    subscription_plan:    string;
    last_cloud_handshake: string | null;
    created_at:           string;
}

export function Tenants() {
    const [search, setSearch]   = useState('');
    const [status, setStatus]   = useState('');
    const [page, setPage]       = useState(1);

    const { data, isLoading } = useQuery({
        queryKey: ['tenants', search, status, page],
        queryFn:  () => api.get('/admin/tenants', {
            params: { search: search || undefined, status: status || undefined, page, limit: 25 }
        }).then(r => r.data),
        staleTime: 30000
    });

    const tenants: Tenant[] = data?.tenants || [];
    const total: number     = data?.total || 0;
    const totalPages        = Math.ceil(total / 25);

    return (
        <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-gray-900">Tenants ({total})</h1>
                <Link
                    to="/tenants/new"
                    className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition"
                >
                    <Plus className="w-4 h-4" /> New Tenant
                </Link>
            </div>

            {/* Filters */}
            <div className="flex gap-3 flex-wrap">
                <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search name or email..."
                        value={search}
                        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                        className="pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-64"
                    />
                </div>
                <select
                    value={status}
                    onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                    className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                    <option value="">All statuses</option>
                    <option value="active">Active</option>
                    <option value="past_due">Past Due</option>
                    <option value="suspended">Suspended</option>
                    <option value="offline_timeout">Offline Timeout</option>
                    <option value="cancelled">Cancelled</option>
                </select>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            {['Business', 'Category', 'Status', 'Plan', 'Overdue', 'Last Handshake', ''].map((h) => (
                                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {isLoading ? (
                            <tr><td colSpan={7} className="p-8 text-center text-gray-400">Loading...</td></tr>
                        ) : tenants.length === 0 ? (
                            <tr><td colSpan={7} className="p-8 text-center text-gray-400">No tenants found</td></tr>
                        ) : tenants.map((t) => (
                            <tr key={t.tenant_id} className="hover:bg-gray-50 transition">
                                <td className="px-4 py-3">
                                    <div className="font-medium text-gray-900">{t.business_name}</div>
                                    <div className="text-xs text-gray-500">{t.owner_email}</div>
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 capitalize">{t.business_category}</td>
                                <td className="px-4 py-3">
                                    <span className={clsx('px-2 py-1 rounded-full text-xs font-medium',
                                        STATUS_BADGE[t.account_status] || 'bg-gray-100 text-gray-800')}>
                                        {t.account_status.replace('_', ' ')}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600">{t.subscription_plan}</td>
                                <td className="px-4 py-3 text-sm">
                                    {t.days_overdue > 0
                                        ? <span className="text-red-600 font-medium">{t.days_overdue}d</span>
                                        : <span className="text-gray-400">—</span>}
                                </td>
                                <td className="px-4 py-3 text-xs text-gray-500">
                                    {t.last_cloud_handshake
                                        ? formatDistanceToNow(new Date(t.last_cloud_handshake), { addSuffix: true })
                                        : 'Never'}
                                </td>
                                <td className="px-4 py-3">
                                    <Link to={`/tenants/${t.tenant_id}`} className="text-indigo-600 hover:text-indigo-800">
                                        <ChevronRight className="w-4 h-4" />
                                    </Link>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="px-4 py-3 border-t flex items-center justify-between">
                        <span className="text-sm text-gray-500">
                            Page {page} of {totalPages} ({total} total)
                        </span>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                disabled={page === 1}
                                className="px-3 py-1 border rounded text-sm disabled:opacity-40 hover:bg-gray-50"
                            >Prev</button>
                            <button
                                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                disabled={page === totalPages}
                                className="px-3 py-1 border rounded text-sm disabled:opacity-40 hover:bg-gray-50"
                            >Next</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}