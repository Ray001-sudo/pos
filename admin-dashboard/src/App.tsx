// =============================================================================
// src/pages/Login.tsx
// =============================================================================
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import toast from 'react-hot-toast';

export function Login() {
    const navigate = useNavigate();
    const login = useAuthStore(s => s.login);
    const [form, setForm] = useState({ tenantId: '', username: '', password: '' });
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            await login(form.tenantId, form.username, form.password);
            navigate('/');
        } catch (err: any) {
            toast.error(err?.response?.data?.error || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-indigo-900 to-indigo-700 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm">
                <div className="text-center mb-8">
                    <div className="w-12 h-12 bg-indigo-600 rounded-xl mx-auto mb-3 flex items-center justify-center">
                        <span className="text-white text-xl font-bold">P</span>
                    </div>
                    <h1 className="text-2xl font-bold text-gray-900">POS Platform</h1>
                    <p className="text-gray-500 text-sm mt-1">Admin Dashboard</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Tenant ID</label>
                        <input
                            type="text"
                            required
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                            value={form.tenantId}
                            onChange={e => setForm({ ...form, tenantId: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                        <input
                            type="text"
                            required
                            value={form.username}
                            onChange={e => setForm({ ...form, username: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                        <input
                            type="password"
                            required
                            value={form.password}
                            onChange={e => setForm({ ...form, password: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition disabled:opacity-60"
                    >
                        {loading ? 'Signing in...' : 'Sign In'}
                    </button>
                </form>
            </div>
        </div>
    );
}


// =============================================================================
// src/components/Layout.tsx — Sidebar navigation shell
// =============================================================================
import { Outlet, NavLink, useNavigate as useNav } from 'react-router-dom';
import { LayoutDashboard, Users, Settings, LogOut, Bell } from 'lucide-react';
import { useAuthStore as useAuth } from '../store/authStore';
import clsx from 'clsx';

const NAV_ITEMS = [
    { to: '/',        icon: <LayoutDashboard className="w-5 h-5" />, label: 'Dashboard' },
    { to: '/tenants', icon: <Users className="w-5 h-5" />,           label: 'Tenants'   },
    { to: '/settings',icon: <Settings className="w-5 h-5" />,        label: 'Settings'  }
];

export function Layout() {
    const nav     = useNav();
    const logout  = useAuth(s => s.logout);
    const user    = useAuth(s => s.user);

    const handleLogout = async () => {
        await logout();
        nav('/login');
    };

    return (
        <div className="flex h-screen bg-gray-50 overflow-hidden">
            {/* Sidebar */}
            <aside className="w-64 bg-indigo-900 flex flex-col shadow-xl">
                {/* Logo */}
                <div className="h-16 flex items-center px-6 border-b border-indigo-800">
                    <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center mr-3">
                        <span className="text-indigo-700 text-sm font-bold">P</span>
                    </div>
                    <span className="text-white font-semibold">POS Admin</span>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 py-4 space-y-1">
                        const isSuper = user?.role === 'superadmin';
    const activeNavItems = isSuper ? NAV_ITEMS : [
        { to: '/', icon: <LayoutDashboard className="w-5 h-5" />, label: 'Store Overview' },
        { to: '/inventory', icon: <Settings className="w-5 h-5" />, label: 'Inventory' },
        { to: '/taxes', icon: <Settings className="w-5 h-5" />, label: 'Taxes' },
        { to: '/staff', icon: <Users className="w-5 h-5" />, label: 'Staff & CRM' },
        { to: '/reports', icon: <Activity className="w-5 h-5" />, label: 'Reports' }
    ];
                    {activeNavItems.map(({ to, icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            end={to === '/'}
                            className={({ isActive }) => clsx(
                                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition',
                                isActive
                                    ? 'bg-white/10 text-white'
                                    : 'text-indigo-200 hover:bg-white/5 hover:text-white'
                            )}
                        >
                            {icon} {label}
                        </NavLink>
                    ))}
                </nav>

                {/* User info */}
                <div className="px-3 py-4 border-t border-indigo-800">
                    <div className="flex items-center gap-3 px-3 mb-2">
                        <div className="w-8 h-8 bg-indigo-700 rounded-full flex items-center justify-center">
                            <span className="text-white text-xs font-medium">
                                {user?.role?.charAt(0).toUpperCase()}
                            </span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-white text-sm font-medium truncate">{user?.role}</p>
                            <p className="text-indigo-300 text-xs truncate">{user?.tenant_id?.slice(0, 8)}...</p>
                        </div>
                    </div>
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-indigo-200 hover:bg-white/5 hover:text-white text-sm transition"
                    >
                        <LogOut className="w-4 h-4" /> Sign out
                    </button>
                </div>
            </aside>

            {/* Main content */}
            <main className="flex-1 overflow-auto">
                <Outlet />
            </main>
        </div>
    );
}



// =============================================================================
// src/pages/TenantDashboard.tsx
// =============================================================================
export function TenantDashboard() {
    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-4">Store Dashboard</h1>
            <div className="grid grid-cols-3 gap-4">
                <div className="bg-white p-5 rounded-xl border shadow-sm">
                    <h2 className="text-gray-500">Today's Sales</h2>
                    <p className="text-2xl font-bold">$1,240.50</p>
                </div>
                <div className="bg-white p-5 rounded-xl border shadow-sm">
                    <h2 className="text-gray-500">Low Stock Alerts</h2>
                    <p className="text-2xl font-bold text-amber-500">12 items</p>
                </div>
                <div className="bg-white p-5 rounded-xl border shadow-sm">
                    <h2 className="text-gray-500">Active Shifts</h2>
                    <p className="text-2xl font-bold text-green-500">2 Terminals</p>
                </div>
            </div>
        </div>
    );
}

export function Inventory() {
    return <div className="p-6"><h1 className="text-2xl font-bold">Inventory & Variants</h1><p>Manage products, components (recipes), and variants here.</p></div>;
}

export function Taxes() {
    return <div className="p-6"><h1 className="text-2xl font-bold">Tax Groups & Rates</h1><p>Configure tax brackets.</p></div>;
}

export function StaffCRM() {
    return <div className="p-6"><h1 className="text-2xl font-bold">Staff & CRM</h1><p>Manage custom roles, suppliers, and customer loyalty.</p></div>;
}

export function Reports() {
    return <div className="p-6"><h1 className="text-2xl font-bold">X/Z Shift Reports</h1><p>View cash-up reports.</p></div>;
}

// =============================================================================
// src/App.tsx — Router setup
// =============================================================================
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 30000, retry: 1 }
    }
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const isAuthenticated = useAuth(s => s.isAuthenticated);
    return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <Routes>
                    <Route path="/login" element={<Login />} />
                    <Route
                        path="/"
                        element={
                            <ProtectedRoute>
                                <Layout />
                            </ProtectedRoute>
                        }
                    >
                        <Route index element={useAuth(s => s.user)?.role === 'superadmin' ? <Dashboard /> : <TenantDashboard />} />
                        <Route path="tenants" element={<Tenants />} />
                        <Route path="tenants/:id" element={<TenantDetail />} />
                        <Route path="inventory" element={<Inventory />} />
                        <Route path="taxes" element={<Taxes />} />
                        <Route path="staff" element={<StaffCRM />} />
                        <Route path="reports" element={<Reports />} />
                    </Route>
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </BrowserRouter>
            <Toaster position="top-right" />
        </QueryClientProvider>
    );
}


// =============================================================================
// src/main.tsx — Entry point
// =============================================================================
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
