import os
import re

CPP_SRC = "c:/Users/dedll/Desktop/pos-platform/pos-platform/cpp-client/src"
REACT_SRC = "c:/Users/dedll/Desktop/pos-platform/pos-platform/admin-dashboard/src"

def patch_cpp():
    checkout_cpp = os.path.join(CPP_SRC, "modules/checkout/CheckoutModule.cpp")
    with open(checkout_cpp, "r", encoding="utf-8") as f:
        content = f.read()

    # Apply discounts considering max_discount_percent
    discount_patch = """void CartManager::applyDiscount(double discountPercent, double maxAllowed) {
    discountPercent_ = std::max(0.0, std::min(maxAllowed, discountPercent));
}"""
    content = content.replace("void CartManager::applyDiscount(double discountPercent) {\n    discountPercent_ = std::max(0.0, std::min(100.0, discountPercent));\n}", discount_patch)
    content = content.replace("void applyDiscount(double discountPercent);", "void applyDiscount(double discountPercent, double maxAllowed = 100.0);")

    # Change addItem to join with local_tax_rates if tax_group_id is present
    item_query_orig = '"SELECT product_id, name, price, tax_rate, stock_quantity, is_active "\n        "FROM local_products WHERE product_id = ? AND is_active = \'1\';"'
    item_query_new = '"SELECT p.product_id, p.name, p.price, COALESCE(tr.percentage, p.tax_rate) as tax_rate, p.stock_quantity, p.is_active "\n        "FROM local_products p "\n        "LEFT JOIN local_tax_rates tr ON p.tax_group_id = tr.group_id "\n        "WHERE p.product_id = ? AND p.is_active = \'1\';"'
    content = content.replace(item_query_orig, item_query_new)

    with open(checkout_cpp, "w", encoding="utf-8") as f:
        f.write(content)

    print("Patched CheckoutModule.cpp")

def patch_react():
    app_tsx = os.path.join(REACT_SRC, "App.tsx")
    with open(app_tsx, "r", encoding="utf-8") as f:
        content = f.read()

    # Add Tenant Dashboard components
    tenant_components = """
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
"""
    content = content.replace("// =============================================================================\n// src/App.tsx", tenant_components + "\n// =============================================================================\n// src/App.tsx")

    # Update Layout nav items based on role
    nav_update = """    const isSuper = user?.role === 'superadmin';
    const activeNavItems = isSuper ? NAV_ITEMS : [
        { to: '/', icon: <LayoutDashboard className="w-5 h-5" />, label: 'Store Overview' },
        { to: '/inventory', icon: <Settings className="w-5 h-5" />, label: 'Inventory' },
        { to: '/taxes', icon: <Settings className="w-5 h-5" />, label: 'Taxes' },
        { to: '/staff', icon: <Users className="w-5 h-5" />, label: 'Staff & CRM' },
        { to: '/reports', icon: <Activity className="w-5 h-5" />, label: 'Reports' }
    ];"""
    content = content.replace("const NAV_ITEMS = [", "const NAV_ITEMS = [") # noop find
    content = content.replace("{NAV_ITEMS.map(({ to, icon, label }) => (", nav_update + "\n                    {activeNavItems.map(({ to, icon, label }) => (")

    # Update routing logic
    route_update = """                        <Route index element={useAuth(s => s.user)?.role === 'superadmin' ? <Dashboard /> : <TenantDashboard />} />
                        <Route path="tenants" element={<Tenants />} />
                        <Route path="tenants/:id" element={<TenantDetail />} />
                        <Route path="inventory" element={<Inventory />} />
                        <Route path="taxes" element={<Taxes />} />
                        <Route path="staff" element={<StaffCRM />} />
                        <Route path="reports" element={<Reports />} />"""
    content = content.replace("""                        <Route index element={<Dashboard />} />
                        <Route path="tenants" element={<Tenants />} />
                        <Route path="tenants/:id" element={<TenantDetail />} />""", route_update)

    with open(app_tsx, "w", encoding="utf-8") as f:
        f.write(content)

    print("Patched App.tsx")

patch_cpp()
patch_react()
print("Phase 2 patch completed successfully.")
