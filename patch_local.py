import os

SCHEMA_PATH = "c:/Users/dedll/Desktop/pos-platform/pos-platform/database/local_schema.sql"

with open(SCHEMA_PATH, "r") as f:
    content = f.read()

# 1. Modify local_products table
products_target = """CREATE TABLE IF NOT EXISTS local_products (
    product_id      TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sku             TEXT,
    barcode         TEXT,
    price           REAL NOT NULL CHECK (price >= 0),
    cost_price      REAL,
    stock_quantity  INTEGER NOT NULL DEFAULT 0,
    category        TEXT,
    unit            TEXT,
    tax_rate        REAL NOT NULL DEFAULT 0,
    is_active       INTEGER NOT NULL DEFAULT 1,
    batch_number    TEXT,
    expiry_date     TEXT,
    requires_prescription INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);"""

products_replacement = """CREATE TABLE IF NOT EXISTS local_tax_groups (
    group_id        TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS local_tax_rates (
    rate_id         TEXT PRIMARY KEY,
    group_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    percentage      REAL NOT NULL DEFAULT 0,
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS local_products (
    product_id      TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sku             TEXT,
    barcode         TEXT,
    price           REAL NOT NULL CHECK (price >= 0),
    cost_price      REAL,
    stock_quantity  INTEGER NOT NULL DEFAULT 0,
    reorder_level   INTEGER NOT NULL DEFAULT 0,
    category        TEXT,
    unit            TEXT,
    tax_rate        REAL NOT NULL DEFAULT 0,
    tax_group_id    TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    batch_number    TEXT,
    expiry_date     TEXT,
    requires_prescription INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);"""

content = content.replace(products_target, products_replacement)


# 2. Modify local_customers table
customers_target = """CREATE TABLE IF NOT EXISTS local_customers (
    customer_id     TEXT PRIMARY KEY,
    full_name       TEXT,
    phone           TEXT,
    email           TEXT,
    loyalty_points  INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);"""

customers_replacement = """CREATE TABLE IF NOT EXISTS local_customers (
    customer_id     TEXT PRIMARY KEY,
    full_name       TEXT,
    phone           TEXT,
    email           TEXT,
    loyalty_points  INTEGER NOT NULL DEFAULT 0,
    loyalty_tier    TEXT,
    last_synced_at  TEXT
);"""

content = content.replace(customers_target, customers_replacement)


# 3. Append new tables at the end of the file
new_tables = """
-- =============================================================================
-- INVENTORY (Feature 1)
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_product_variants (
    variant_id      TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    sku             TEXT,
    barcode         TEXT,
    price           REAL NOT NULL CHECK (price >= 0),
    cost_price      REAL,
    stock_quantity  INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS local_product_components (
    recipe_id            TEXT PRIMARY KEY,
    parent_product_id    TEXT NOT NULL,
    component_product_id TEXT NOT NULL,
    quantity             REAL NOT NULL CHECK (quantity > 0),
    last_synced_at       TEXT
);

-- =============================================================================
-- TRANSACTIONS (Feature 3)
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_quotes (
    quote_id        TEXT PRIMARY KEY,
    customer_id     TEXT,
    total           REAL NOT NULL,
    valid_until     TEXT,
    status          TEXT NOT NULL,
    items_json      TEXT NOT NULL,
    is_synced       INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS local_invoices (
    invoice_id      TEXT PRIMARY KEY,
    customer_id     TEXT,
    total           REAL NOT NULL,
    due_date        TEXT,
    status          TEXT NOT NULL,
    items_json      TEXT NOT NULL,
    is_synced       INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS local_expenses (
    expense_id      TEXT PRIMARY KEY,
    user_id         TEXT,
    category        TEXT NOT NULL,
    amount          REAL NOT NULL,
    description     TEXT,
    expense_date    TEXT,
    is_synced       INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);

-- =============================================================================
-- STAFF/CONTROLS (Feature 4)
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_custom_roles (
    role_id         TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    permissions     TEXT NOT NULL, -- JSON
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS local_users (
    user_id         TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL,
    custom_role_id  TEXT,
    pin_hash        TEXT,
    commission_rate REAL NOT NULL DEFAULT 0,
    max_discount_percent REAL NOT NULL DEFAULT 100,
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_synced_at  TEXT
);

-- =============================================================================
-- CRM (Feature 5)
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_suppliers (
    supplier_id     TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    contact_phone   TEXT,
    contact_email   TEXT,
    address         TEXT,
    last_synced_at  TEXT
);

-- =============================================================================
-- REPORTING (Feature 6)
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_shift_reports (
    report_id       TEXT PRIMARY KEY,
    terminal_id     TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    start_time      TEXT NOT NULL,
    end_time        TEXT,
    expected_cash   REAL NOT NULL,
    actual_cash     REAL,
    difference      REAL,
    report_type     TEXT NOT NULL,
    is_synced       INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);
"""

content += new_tables

with open(SCHEMA_PATH, "w") as f:
    f.write(content)

print("Local schema patched successfully.")
