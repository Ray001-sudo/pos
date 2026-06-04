import os

SCHEMA_PATH = "c:/Users/dedll/Desktop/pos-platform/pos-platform/database/cloud_schema.sql"

with open(SCHEMA_PATH, "r") as f:
    content = f.read()

# 1. Modify users table
users_target = """-- =============================================================================
-- USERS
-- =============================================================================
CREATE TABLE users (
    user_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    username        VARCHAR(100) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,   -- bcrypt minimum 12 rounds
    role            user_role NOT NULL DEFAULT 'cashier',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, username)
);"""

users_replacement = """-- =============================================================================
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
);"""

content = content.replace(users_target, users_replacement)

# 2. Modify products table
products_target = """-- =============================================================================
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
    category                VARCHAR(100),
    unit                    VARCHAR(50),
    tax_rate                DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
    is_active               BOOLEAN NOT NULL DEFAULT true,
    -- Pharmacy-specific
    batch_number            VARCHAR(100),
    expiry_date             DATE,
    requires_prescription   BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);"""

products_replacement = """-- =============================================================================
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
);"""

content = content.replace(products_target, products_replacement)


# 3. Modify customers table
customers_target = """CREATE TABLE customers (
    customer_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    email           VARCHAR(255),
    loyalty_points  INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);"""

customers_replacement = """CREATE TABLE customers (
    customer_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    email           VARCHAR(255),
    loyalty_points  INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
    loyalty_tier    VARCHAR(50),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);"""

content = content.replace(customers_target, customers_replacement)


# 4. Insert new tables before AI INSIGHTS
insertion_point = """-- =============================================================================
-- AI INSIGHTS TABLE
-- =============================================================================
"""

new_tables = """-- =============================================================================
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

"""

content = content.replace(insertion_point, new_tables + insertion_point)

with open(SCHEMA_PATH, "w") as f:
    f.write(content)

print("Cloud schema patched successfully.")
