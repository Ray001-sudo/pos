-- =============================================================================
-- POS PLATFORM — LOCAL SQLite SCHEMA (C++ Client)
-- Encrypted with SQLCipher (AES-256-CBC)
-- Encryption key derived from hardware fingerprint via PBKDF2 (100,000 iterations)
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- =============================================================================
-- CONFIG STORE
-- Key-value store for all application configuration and state
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_config (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);
-- Expected keys:
--   tenant_id                   TEXT (UUID)
--   terminal_id                 TEXT (UUID)
--   terminal_name               TEXT
--   cloud_url                   TEXT
--   sync_enabled                TEXT ('0' or '1')
--   account_status              TEXT ('active'|'past_due'|'suspended'|'offline_timeout'|'cancelled')
--   days_overdue                TEXT (integer string)
--   module_flags_json           TEXT (JSON object)
--   license_expiry_timestamp    TEXT (Unix timestamp string)
--   deployment_mode             TEXT ('cloud_hybrid' or 'fully_offline')
--   jwt_token                   TEXT (current access token)
--   jwt_expiry                  TEXT (Unix timestamp string)
--   -- Handshake token fields (anti-tamper time-bomb)
--   handshake_valid_until       TEXT (Unix timestamp string)
--   handshake_last_verified     TEXT (Unix timestamp string)
--   handshake_signature         TEXT (raw HMAC-SHA256 hex string)
--   -- Override tracking
--   override_last_date          TEXT (YYYY-MM-DD of last used override)

-- =============================================================================
-- LOCAL PRODUCTS CACHE
-- Synced from cloud; used for barcode lookup during checkout
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_tax_groups (
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
);

CREATE INDEX IF NOT EXISTS idx_local_products_barcode ON local_products(barcode);
CREATE INDEX IF NOT EXISTS idx_local_products_active ON local_products(is_active);
CREATE INDEX IF NOT EXISTS idx_local_products_expiry ON local_products(expiry_date) WHERE expiry_date IS NOT NULL;

-- =============================================================================
-- LOCAL TRANSACTIONS (Offline-first, synced later)
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_transactions (
    receipt_id      TEXT PRIMARY KEY,           -- UUID generated locally (used as distributed PK)
    cashier_id      TEXT NOT NULL,
    subtotal        REAL NOT NULL CHECK (subtotal >= 0),
    tax_total       REAL NOT NULL DEFAULT 0,
    discount_total  REAL NOT NULL DEFAULT 0,
    grand_total     REAL NOT NULL CHECK (grand_total >= 0),
    payment_method  TEXT NOT NULL,              -- 'cash'|'card'|'mobile_money'|'split'
    sale_timestamp  TEXT NOT NULL,              -- ISO-8601 UTC
    is_voided       INTEGER NOT NULL DEFAULT 0,
    void_reason     TEXT,
    is_synced       INTEGER NOT NULL DEFAULT 0, -- 0 = pending upload, 1 = confirmed on cloud
    sync_attempts   INTEGER NOT NULL DEFAULT 0,
    last_sync_error TEXT,
    items_json      TEXT NOT NULL               -- JSON array of CartItem objects
);

-- Partial index on unsynced transactions for efficient batch processing
CREATE INDEX IF NOT EXISTS idx_transactions_unsynced
    ON local_transactions(is_synced, sync_attempts)
    WHERE is_synced = 0;

CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
    ON local_transactions(sale_timestamp DESC);

-- =============================================================================
-- LOCAL CUSTOMERS CACHE
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_customers (
    customer_id     TEXT PRIMARY KEY,
    full_name       TEXT,
    phone           TEXT,
    email           TEXT,
    loyalty_points  INTEGER NOT NULL DEFAULT 0,
    loyalty_tier    TEXT,
    last_synced_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_customers_phone ON local_customers(phone);

-- =============================================================================
-- LOCAL AUDIT LOG
-- Persisted locally even in offline mode; synced to cloud when online
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_audit_log (
    log_id      TEXT PRIMARY KEY,
    user_id     TEXT,
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    details     TEXT,           -- JSON blob
    timestamp   TEXT NOT NULL   -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_local_audit_timestamp ON local_audit_log(timestamp DESC);

-- =============================================================================
-- RESTAURANT MODULE — LOCAL TABLES
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_restaurant_tables (
    table_id            TEXT PRIMARY KEY,
    table_number        TEXT NOT NULL,
    capacity            INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'available',
    current_receipt_id  TEXT,
    last_synced_at      TEXT
);

CREATE TABLE IF NOT EXISTS local_kitchen_orders (
    kot_id      TEXT PRIMARY KEY,
    table_id    TEXT NOT NULL,
    items_json  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL,
    is_synced   INTEGER NOT NULL DEFAULT 0
);

-- =============================================================================
-- MEMBERSHIP MODULE — LOCAL CACHE
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_memberships (
    membership_id   TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL,
    plan_name       TEXT NOT NULL,
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_synced_at  TEXT
);

-- =============================================================================
-- APPOINTMENTS MODULE — LOCAL CACHE
-- =============================================================================
CREATE TABLE IF NOT EXISTS local_appointments (
    appointment_id  TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL,
    staff_id        TEXT NOT NULL,
    service_name    TEXT NOT NULL,
    scheduled_at    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'booked',
    is_synced       INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_appointments_scheduled
    ON local_appointments(scheduled_at);

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
