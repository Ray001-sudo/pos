// =============================================================================
// src/pages/TenantDetail.tsx — View and manage a single tenant
// =============================================================================
import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Shield, ToggleLeft, ToggleRight, History } from 'lucide-react';

const MODULE_LABELS: Record<string, string> = {
    module_restaurant:    'Restaurant / KOT',
    module_pharmacy:      'Pharmacy',
    module_gym:           'Gym',
    module_salon:         'Salon',
    module_hotel:         'Hotel',
    module_wholesale:     'Wholesale',
    module_ai_analytics:  'AI Analytics',
    module_multi_terminal: 'Multi-Terminal'
};

export function TenantDetail() {
    const { id }    = useParams<{ id: string }>();
    const qc        = useQueryClient();

    const { data: tenant, isLoading } = useQuery({
        queryKey: ['tenant', id],
        queryFn:  () => api.get(`/admin/tenants?search=${id}`).then(r => r.data.tenants[0])
    });

    const { data: billing } = useQuery({
        queryKey: ['tenant-billing', id],
        queryFn:  () => api.get(`/admin/tenants/${id}/billing`).then(r => r.data)
    });

    const statusMutation = useMutation({
        mutationFn: ({ status, reason }: { status: string; reason: string }) =>
            api.put(`/admin/tenants/${id}/status`, { status, reason }),
        onSuccess: () => {
            toast.success('Status updated');
            qc.invalidateQueries({ queryKey: ['tenant', id] });
            qc.invalidateQueries({ queryKey: ['tenants'] });
        },
        onError: () => toast.error('Failed to update status')
    });

    const moduleMutation = useMutation({
        mutationFn: (modules: Record<string, boolean>) =>
            api.put(`/admin/tenants/${id}/modules`, modules),
        onSuccess: () => {
            toast.success('Modules updated');
            qc.invalidateQueries({ queryKey: ['tenant', id] });
        },
        onError: () => toast.error('Failed to update modules')
    });

    if (isLoading) return <div className="p-8 animate-pulse">Loading tenant...</div>;
    if (!tenant) return <div className="p-8 text-red-600">Tenant not found</div>;

    const handleStatusChange = (newStatus: string) => {
        const reason = window.prompt(`Reason for changing to "${newStatus}":`);
        if (reason === null) return;
        statusMutation.mutate({ status: newStatus, reason });
    };

    const handleModuleToggle = (moduleKey: string, currentValue: boolean) => {
        moduleMutation.mutate({ [moduleKey]: !currentValue });
    };

    return (
        <div className="p-6 space-y-6 max-w-5xl">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">{tenant.business_name}</h1>
                    <p className="text-gray-500 mt-1">{tenant.owner_email} · {tenant.business_category}</p>
                </div>
                <span className={clsx('px-3 py-1 rounded-full text-sm font-medium',
                    STATUS_BADGE[tenant.account_status] || 'bg-gray-100 text-gray-800')}>
                    {tenant.account_status}
                </span>
            </div>

            {/* Status controls */}
            <div className="bg-white rounded-xl border shadow-sm p-5">
                <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                    <Shield className="w-4 h-4" /> Account Status
                </h2>
                <div className="flex flex-wrap gap-2">
                    {['active', 'past_due', 'suspended', 'cancelled'].map((s) => (
                        <button
                            key={s}
                            onClick={() => handleStatusChange(s)}
                            disabled={tenant.account_status === s || statusMutation.isPending}
                            className={clsx(
                                'px-3 py-1.5 rounded-lg text-sm font-medium border transition',
                                tenant.account_status === s
                                    ? 'bg-gray-900 text-white border-gray-900 cursor-default'
                                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                            )}
                        >
                            {s.replace('_', ' ')}
                        </button>
                    ))}
                </div>
                {tenant.days_overdue > 0 && (
                    <p className="mt-3 text-sm text-red-600 font-medium">
                        ⚠ {tenant.days_overdue} days overdue
                    </p>
                )}
            </div>

            {/* Module flags */}
            <div className="bg-white rounded-xl border shadow-sm p-5">
                <h2 className="font-semibold text-gray-900 mb-4">Module Access</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(MODULE_LABELS).map(([key, label]) => {
                        const enabled = tenant[key] === true;
                        return (
                            <button
                                key={key}
                                onClick={() => handleModuleToggle(key, enabled)}
                                disabled={moduleMutation.isPending}
                                className={clsx(
                                    'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition',
                                    enabled
                                        ? 'bg-indigo-50 border-indigo-300 text-indigo-800'
                                        : 'bg-gray-50 border-gray-200 text-gray-500'
                                )}
                            >
                                {enabled
                                    ? <ToggleRight className="w-4 h-4 text-indigo-600" />
                                    : <ToggleLeft className="w-4 h-4 text-gray-400" />}
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Billing events */}
            <div className="bg-white rounded-xl border shadow-sm p-5">
                <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                    <History className="w-4 h-4" /> Billing Events
                </h2>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                    {(billing?.events || []).length === 0 ? (
                        <p className="text-sm text-gray-400">No billing events recorded</p>
                    ) : (billing?.events || []).map((e: any) => (
                        <div key={e.event_id} className="flex items-center justify-between text-sm border-b pb-2">
                            <div>
                                <span className="font-medium text-gray-800">
                                    {e.event_type.replace('_', ' ')}
                                </span>
                                {e.notes && <span className="text-gray-500 ml-2">— {e.notes}</span>}
                            </div>
                            <span className="text-gray-400 text-xs">
                                {formatDistanceToNow(new Date(e.event_timestamp), { addSuffix: true })}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
