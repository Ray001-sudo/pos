// =============================================================================
// src/pages/Dashboard.tsx — Platform-wide metrics overview
// =============================================================================
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    PieChart, Pie, Cell, Legend
} from 'recharts';
import { Users, AlertTriangle, DollarSign, Activity } from 'lucide-react';
import api from '../api/client';

const STATUS_COLORS: Record<string, string> = {
    active:           '#22c55e',
    past_due:         '#f59e0b',
    suspended:        '#ef4444',
    offline_timeout:  '#6b7280',
    cancelled:        '#1f2937'
};

interface PlatformStats {
    tenant_status_breakdown: Array<{ account_status: string; count: string }>;
    last_30_days:            { total_transactions: string; total_revenue: string };
    overdue_summary:         { overdue_tenants: string; avg_days_overdue: string };
}

export function Dashboard() {
    const { data, isLoading } = useQuery<PlatformStats>({
        queryKey: ['admin-stats'],
        queryFn:  () => api.get('/admin/stats').then(r => r.data),
        refetchInterval: 60000
    });

    if (isLoading) return <div className="animate-pulse p-8">Loading...</div>;

    const breakdown = data?.tenant_status_breakdown || [];
    const totalTenants = breakdown.reduce((sum, s) => sum + parseInt(s.count), 0);

    const summaryCards = [
        {
            label:   'Total Tenants',
            value:   totalTenants,
            icon:    <Users className="w-6 h-6" />,
            color:   'bg-blue-500'
        },
        {
            label:   'Overdue Accounts',
            value:   data?.overdue_summary?.overdue_tenants || 0,
            icon:    <AlertTriangle className="w-6 h-6" />,
            color:   'bg-amber-500'
        },
        {
            label:   '30d Revenue',
            value:   `$${parseFloat(data?.last_30_days?.total_revenue || '0').toLocaleString()}`,
            icon:    <DollarSign className="w-6 h-6" />,
            color:   'bg-green-500'
        },
        {
            label:   '30d Transactions',
            value:   parseInt(data?.last_30_days?.total_transactions || '0').toLocaleString(),
            icon:    <Activity className="w-6 h-6" />,
            color:   'bg-purple-500'
        }
    ];

    return (
        <div className="p-6 space-y-6">
            <h1 className="text-2xl font-bold text-gray-900">Platform Dashboard</h1>

            {/* Summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {summaryCards.map((card) => (
                    <div key={card.label} className="bg-white rounded-xl shadow-sm border p-5 flex items-center gap-4">
                        <div className={`${card.color} text-white p-3 rounded-lg`}>
                            {card.icon}
                        </div>
                        <div>
                            <p className="text-sm text-gray-500">{card.label}</p>
                            <p className="text-2xl font-semibold text-gray-900">{card.value}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* Tenant status pie chart */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white rounded-xl shadow-sm border p-5">
                    <h2 className="text-lg font-semibold mb-4">Tenant Status Breakdown</h2>
                    <ResponsiveContainer width="100%" height={280}>
                        <PieChart>
                            <Pie
                                data={breakdown}
                                dataKey="count"
                                nameKey="account_status"
                                cx="50%" cy="50%"
                                outerRadius={100}
                                label={({ account_status, count }) =>
                                    `${account_status} (${count})`}
                            >
                                {breakdown.map((entry) => (
                                    <Cell
                                        key={entry.account_status}
                                        fill={STATUS_COLORS[entry.account_status] || '#94a3b8'}
                                    />
                                ))}
                            </Pie>
                            <Legend />
                            <Tooltip />
                        </PieChart>
                    </ResponsiveContainer>
                </div>

                <div className="bg-white rounded-xl shadow-sm border p-5">
                    <h2 className="text-lg font-semibold mb-4">Status Count</h2>
                    <ResponsiveContainer width="100%" height={280}>
                        <BarChart data={breakdown}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="account_status" tick={{ fontSize: 12 }} />
                            <YAxis />
                            <Tooltip />
                            <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
}