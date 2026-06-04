-- =============================================================================
-- POS PLATFORM — CLOUD PostgreSQL SCHEMA
-- Multi-tenant, Row-Level Security enforced on every table
-- =============================================================================

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- ENUM TYPES
-- =============================================================================
CREATE TYPE business_category AS ENUM (
    'retail', 'wholesale', 'restaurant', 'pharmacy', 'salon', 'gym', 'hotel', 'cafe'
);

CREATE TYPE account_status AS ENUM (
    'active', 'past_due', 'suspended', 'offline_timeout', 'cancelled'
);

CREATE TYPE user_role AS ENUM (
    'superadmin', 'admin', 'manager', 'cashier'
);

CREATE TYPE payment_method AS ENUM (
    'cash', 'card', 'mobile_money', 'split'
);

CREATE TYPE table_status AS ENUM (
    'available', 'occupied', 'reserved', 'cleaning'
);

CREATE TYPE kot_status AS ENUM (
    'pending', 'preparing', 'ready', 'served'
);

CREATE TYPE appointment_status AS ENUM (
    'booked', 'confirmed', 'completed', 'cancelled'
);

CREATE TYPE billing_event_type AS ENUM (
    'payment_success', 'payment_failed', 'suspended', 'reactivated', 'grace_period_started'
);

CREATE TYPE insight_type AS ENUM (
    'restock_forecast', 'dead_stock_alert', 'fraud_alert', 'expiry_warning'
);

-- =============================================================================
-- TENANTS TABLE
-- =============================================================================
CREATE TABLE tenants (
    tenant_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name       VARCHAR(255) NOT NULL,
    business_category   business_category NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    subscription_plan   VARCHAR(100) NOT NULL DEFAULT 'starter',
    account_status      account_status NOT NULL DEFAULT 'active',
    payment_due_date    DATE,
    days_overdue        INTEGER NOT NULL DEFAULT 0 CHECK (days_overdue >= 0),
    last_cloud_handshake TIMESTAMP WITH TIME ZONE,
    license_key_hash    VARCHAR(512),   -- For offline clients: SHA-256 of license.key
    owner_email         VARCHAR(255) NOT NULL,
    owner_phone         VARCHAR(50),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Superadmin can see all tenants; tenants can only see themselves
CREATE POLICY tenant_isolation ON tenants
    USING (
        current_setting('app.current_tenant_id', true)::uuid = tenant_id
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_tenants_status ON tenants(account_status);
CREATE INDEX idx_tenants_due_date ON tenants(payment_due_date);
CREATE INDEX idx_tenants_handshake ON tenants(last_cloud_handshake);

-- =============================================================================
-- TENANT FEATURE FLAGS
-- =============================================================================
CREATE TABLE tenant_feature_flags (
    flag_id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    module_restaurant       BOOLEAN NOT NULL DEFAULT false,
    module_pharmacy         BOOLEAN NOT NULL DEFAULT false,
    module_gym              BOOLEAN NOT NULL DEFAULT false,
    module_salon            BOOLEAN NOT NULL DEFAULT false,
    module_hotel            BOOLEAN NOT NULL DEFAULT false,
    module_wholesale        BOOLEAN NOT NULL DEFAULT false,
    module_ai_analytics     BOOLEAN NOT NULL DEFAULT false,
    module_multi_terminal   BOOLEAN NOT NULL DEFAULT false,
    updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_feature_flags_isolation ON tenant_feature_flags
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE UNIQUE INDEX idx_tenant_feature_flags_tenant ON tenant_feature_flags(tenant_id);

-- =============================================================================
-- TERMINALS
-- =============================================================================
CREATE TABLE terminals (
    terminal_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    terminal_name   VARCHAR(255) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_seen       TIMESTAMP WITH TIME ZONE,
    hw_fingerprint  VARCHAR(512)    -- Hardware fingerprint hash for license binding
);

ALTER TABLE terminals ENABLE ROW LEVEL SECURITY;

CREATE POLICY terminals_isolation ON terminals
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_terminals_tenant ON terminals(tenant_id);

-- =============================================================================
-- CUSTOM ROLES (Feature 4)
-- =============================================================================
CREATE TABLE custom_roles (
    role_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE custom_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY custom_roles_isolation ON custom_roles
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_custom_roles_tenant ON custom_roles(tenant_id);

-- =============================================================================
-- USERS
-- =============================================================================
CREATE TABLE users (
    user_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    username        VARCHAR(100) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,   -- bcrypt minimum 12 rounds
    role            user_role NOT NULL DEFAULT 'cashier',
    custom_role_id  UUID REFERENCES custom_roles(role_id) ON DELETE SET NULL,
    pin_hash        VARCHAR(255),
    commission_rate DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (commission_rate >= 0),
    max_discount_percent DECIMAL(5,2) NOT NULL DEFAULT 100 CHECK (max_discount_percent >= 0 AND max_discount_percent <= 100),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, username)
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_isolation ON users
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_username ON users(tenant_id, username);

-- =============================================================================
-- TAX GROUPS & RATES (Feature 2)
-- =============================================================================
CREATE TABLE tax_groups (
    group_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE tax_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY tax_groups_isolation ON tax_groups
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_tax_groups_tenant ON tax_groups(tenant_id);

CREATE TABLE tax_rates (
    rate_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    group_id        UUID NOT NULL REFERENCES tax_groups(group_id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    percentage      DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (percentage >= 0),
    is_active       BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tax_rates_isolation ON tax_rates
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_tax_rates_tenant ON tax_rates(tenant_id);

-- =============================================================================
-- PRODUCTS
-- =============================================================================
CREATE TABLE products (
    product_id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name                    VARCHAR(255) NOT NULL,
    sku                     VARCHAR(100),
    barcode                 VARCHAR(100),
    price                   DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    cost_price              DECIMAL(10,2) CHECK (cost_price >= 0),
    stock_quantity          INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    reorder_level           INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
    category                VARCHAR(100),
    unit                    VARCHAR(50),
    tax_rate                DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
    tax_group_id            UUID REFERENCES tax_groups(group_id),
    is_active               BOOLEAN NOT NULL DEFAULT true,
    -- Pharmacy-specific
    batch_number            VARCHAR(100),
    expiry_date             DATE,
    requires_prescription   BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_isolation ON products
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_products_barcode ON products(tenant_id, barcode);
CREATE INDEX idx_products_expiry ON products(tenant_id, expiry_date) WHERE expiry_date IS NOT NULL;

-- =============================================================================
-- SALES TRANSACTIONS
-- =============================================================================
CREATE TABLE sales_transactions (
    receipt_id      UUID PRIMARY KEY,       -- UUID generated on the client (distributed PK)
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    terminal_id     UUID NOT NULL REFERENCES terminals(terminal_id),
    cashier_id      UUID NOT NULL REFERENCES users(user_id),
    subtotal        DECIMAL(10,2) NOT NULL CHECK (subtotal >= 0),
    tax_total       DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
    discount_total  DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
    grand_total     DECIMAL(10,2) NOT NULL CHECK (grand_total >= 0),
    payment_method  payment_method NOT NULL,
    sale_timestamp  TIMESTAMP WITH TIME ZONE NOT NULL,
    is_voided       BOOLEAN NOT NULL DEFAULT false,
    void_reason     TEXT,
    synced_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE sales_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sales_transactions_isolation ON sales_transactions
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_sales_tenant ON sales_transactions(tenant_id);
CREATE INDEX idx_sales_timestamp ON sales_transactions(tenant_id, sale_timestamp DESC);
CREATE INDEX idx_sales_cashier ON sales_transactions(tenant_id, cashier_id);

-- =============================================================================
-- SALE ITEMS
-- =============================================================================
CREATE TABLE sale_items (
    item_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    receipt_id      UUID NOT NULL REFERENCES sales_transactions(receipt_id),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    unit_price      DECIMAL(10,2) NOT NULL CHECK (unit_price >= 0),
    line_total      DECIMAL(10,2) NOT NULL CHECK (line_total >= 0)
);

ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY sale_items_isolation ON sale_items
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_sale_items_receipt ON sale_items(receipt_id);
CREATE INDEX idx_sale_items_tenant ON sale_items(tenant_id);
CREATE INDEX idx_sale_items_product ON sale_items(tenant_id, product_id);

-- =============================================================================
-- RESTAURANT MODULE
-- =============================================================================
CREATE TABLE restaurant_tables (
    table_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    table_number        VARCHAR(50) NOT NULL,
    capacity            INTEGER NOT NULL CHECK (capacity > 0),
    status              table_status NOT NULL DEFAULT 'available',
    current_receipt_id  UUID REFERENCES sales_transactions(receipt_id)
);

ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY restaurant_tables_isolation ON restaurant_tables
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_restaurant_tables_tenant ON restaurant_tables(tenant_id);

CREATE TABLE kitchen_orders (
    kot_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    table_id    UUID NOT NULL REFERENCES restaurant_tables(table_id),
    items_json  JSONB NOT NULL,
    status      kot_status NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE kitchen_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY kitchen_orders_isolation ON kitchen_orders
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_kitchen_orders_tenant ON kitchen_orders(tenant_id);
CREATE INDEX idx_kitchen_orders_status ON kitchen_orders(tenant_id, status);

-- =============================================================================
-- CUSTOMERS
-- =============================================================================
CREATE TABLE customers (
    customer_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    email           VARCHAR(255),
    loyalty_points  INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
    loyalty_tier    VARCHAR(50),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_isolation ON customers
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_customers_phone ON customers(tenant_id, phone);

-- =============================================================================
-- GYM / SALON MODULE
-- =============================================================================
CREATE TABLE memberships (
    membership_id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    plan_name       VARCHAR(255) NOT NULL,
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    CHECK (end_date > start_date)
);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_isolation ON memberships
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);
CREATE INDEX idx_memberships_customer ON memberships(tenant_id, customer_id);

CREATE TABLE appointments (
    appointment_id  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    staff_id        UUID NOT NULL REFERENCES users(user_id),
    service_name    VARCHAR(255) NOT NULL,
    scheduled_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    status          appointment_status NOT NULL DEFAULT 'booked'
);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY appointments_isolation ON appointments
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_appointments_tenant ON appointments(tenant_id);
CREATE INDEX idx_appointments_scheduled ON appointments(tenant_id, scheduled_at);

-- =============================================================================
-- BILLING EVENTS
-- =============================================================================
CREATE TABLE billing_events (
    event_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    event_type          billing_event_type NOT NULL,
    event_timestamp     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    amount              DECIMAL(10,2),
    gateway_reference   VARCHAR(255),
    notes               TEXT
);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY billing_events_isolation ON billing_events
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_billing_events_tenant ON billing_events(tenant_id);
CREATE INDEX idx_billing_events_timestamp ON billing_events(tenant_id, event_timestamp DESC);

-- =============================================================================
-- AUDIT LOGS
-- =============================================================================
CREATE TABLE audit_logs (
    log_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(user_id),
    action      VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100),
    entity_id   UUID,
    old_value   JSONB,
    new_value   JSONB,
    ip_address  VARCHAR(45),
    timestamp   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_isolation ON audit_logs
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_audit_logs_tenant ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(tenant_id, timestamp DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(tenant_id, entity_type, entity_id);

-- =============================================================================
-- INVENTORY (Feature 1)
-- =============================================================================
CREATE TABLE product_variants (
    variant_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    sku             VARCHAR(100),
    barcode         VARCHAR(100),
    price           DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    cost_price      DECIMAL(10,2) CHECK (cost_price >= 0),
    stock_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0)
);

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_variants_isolation ON product_variants USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_product_variants_tenant ON product_variants(tenant_id);

CREATE TABLE product_components (
    recipe_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    parent_product_id    UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    component_product_id UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    quantity             DECIMAL(10,2) NOT NULL CHECK (quantity > 0)
);

ALTER TABLE product_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_components_isolation ON product_components USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_product_components_tenant ON product_components(tenant_id);

CREATE TABLE stock_transfers (
    transfer_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    from_terminal_id UUID NOT NULL REFERENCES terminals(terminal_id),
    to_terminal_id   UUID NOT NULL REFERENCES terminals(terminal_id),
    status           VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_isolation ON stock_transfers USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_stock_transfers_tenant ON stock_transfers(tenant_id);

CREATE TABLE stock_transfer_items (
    item_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    transfer_id      UUID NOT NULL REFERENCES stock_transfers(transfer_id) ON DELETE CASCADE,
    product_id       UUID NOT NULL REFERENCES products(product_id),
    quantity         INTEGER NOT NULL CHECK (quantity > 0)
);

ALTER TABLE stock_transfer_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_items_isolation ON stock_transfer_items USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_stock_transfer_items_tenant ON stock_transfer_items(tenant_id);

-- =============================================================================
-- TRANSACTIONS (Feature 3)
-- =============================================================================
CREATE TABLE quotes (
    quote_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(customer_id),
    total           DECIMAL(10,2) NOT NULL CHECK (total >= 0),
    valid_until     TIMESTAMP WITH TIME ZONE,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',
    items_json      JSONB NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY quotes_isolation ON quotes USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_quotes_tenant ON quotes(tenant_id);

CREATE TABLE invoices (
    invoice_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(customer_id),
    total           DECIMAL(10,2) NOT NULL CHECK (total >= 0),
    due_date        DATE,
    status          VARCHAR(50) NOT NULL DEFAULT 'unpaid',
    items_json      JSONB NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_isolation ON invoices USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);

CREATE TABLE expenses (
    expense_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(user_id),
    category        VARCHAR(100) NOT NULL,
    amount          DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
    description     TEXT,
    expense_date    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_isolation ON expenses USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_expenses_tenant ON expenses(tenant_id);

-- =============================================================================
-- CRM (Feature 5)
-- =============================================================================
CREATE TABLE suppliers (
    supplier_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    contact_phone   VARCHAR(50),
    contact_email   VARCHAR(255),
    address         TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY suppliers_isolation ON suppliers USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);

-- =============================================================================
-- REPORTING (Feature 6)
-- =============================================================================
CREATE TABLE shift_reports (
    report_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    terminal_id     UUID NOT NULL REFERENCES terminals(terminal_id),
    user_id         UUID NOT NULL REFERENCES users(user_id),
    start_time      TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time        TIMESTAMP WITH TIME ZONE,
    expected_cash   DECIMAL(10,2) NOT NULL DEFAULT 0,
    actual_cash     DECIMAL(10,2),
    difference      DECIMAL(10,2),
    report_type     VARCHAR(10) NOT NULL, -- 'X' or 'Z'
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE shift_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY shift_reports_isolation ON shift_reports USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_shift_reports_tenant ON shift_reports(tenant_id);

-- =============================================================================
-- CONNECTIVITY (Feature 8)
-- =============================================================================
CREATE TABLE mpesa_transactions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    receipt_id          UUID REFERENCES sales_transactions(receipt_id),
    phone               VARCHAR(50) NOT NULL,
    amount              DECIMAL(10,2) NOT NULL,
    checkout_request_id VARCHAR(100),
    status              VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE mpesa_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY mpesa_transactions_isolation ON mpesa_transactions USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_mpesa_transactions_tenant ON mpesa_transactions(tenant_id);

-- =============================================================================
-- MODERN TOOLS (Feature 9)
-- =============================================================================
CREATE TABLE tenant_integrations (
    integration_id  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    provider        VARCHAR(100) NOT NULL,
    api_key         VARCHAR(500),
    config_json     JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_integrations_isolation ON tenant_integrations USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid OR current_setting('app.is_superadmin', true)::boolean = true);
CREATE INDEX idx_tenant_integrations_tenant ON tenant_integrations(tenant_id);

-- =============================================================================
-- AI INSIGHTS TABLE
-- =============================================================================
CREATE TABLE ai_insights (
    insight_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    insight_type    insight_type NOT NULL,
    product_id      UUID REFERENCES products(product_id),
    payload         JSONB NOT NULL,
    generated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_insights_isolation ON ai_insights
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::uuid
        OR current_setting('app.is_superadmin', true)::boolean = true
    );

CREATE INDEX idx_ai_insights_tenant ON ai_insights(tenant_id);
CREATE INDEX idx_ai_insights_type ON ai_insights(tenant_id, insight_type);
CREATE INDEX idx_ai_insights_expires ON ai_insights(expires_at);

-- =============================================================================
-- HELPER FUNCTION: Set tenant context for RLS
-- Called at the start of every API request via SET LOCAL
-- =============================================================================
CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id UUID, p_is_superadmin BOOLEAN DEFAULT false)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
    PERFORM set_config('app.is_superadmin', p_is_superadmin::text, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- TRIGGER: auto-update updated_at columns
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
