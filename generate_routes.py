import os

ROUTES_DIR = "c:/Users/dedll/Desktop/pos-platform/pos-platform/backend-api/src/routes"

routes = {
    "inventory.js": """'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery, tenantTransaction } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, standardLimiter);

// -----------------------------------------------------------------------------
// VARIANTS
// -----------------------------------------------------------------------------
router.get('/variants', async (req, res) => {
    const { tenant_id } = req.user;
    const { product_id } = req.query;
    let query = `SELECT * FROM product_variants WHERE tenant_id=$1`;
    let params = [tenant_id];
    if (product_id) {
        query += ` AND product_id=$2`;
        params.push(product_id);
    }
    const result = await tenantQuery(query, params, tenant_id);
    return res.json({ variants: result.rows });
});

router.post('/variants', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        product_id: z.string().uuid(),
        name: z.string().min(1),
        sku: z.string().optional(),
        barcode: z.string().optional(),
        price: z.number().nonnegative(),
        cost_price: z.number().nonnegative().optional(),
        stock_quantity: z.number().int().nonnegative().default(0)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const variantId = uuidv4();
    await tenantQuery(
        `INSERT INTO product_variants (variant_id, tenant_id, product_id, name, sku, barcode, price, cost_price, stock_quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [variantId, tenant_id, d.product_id, d.name, d.sku||null, d.barcode||null, d.price, d.cost_price||null, d.stock_quantity],
        tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'inventory.create_variant', entityType: 'product_variants', entityId: variantId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ variant_id: variantId });
});

// -----------------------------------------------------------------------------
// COMPONENTS (Recipes)
// -----------------------------------------------------------------------------
router.get('/components', async (req, res) => {
    const { tenant_id } = req.user;
    const { parent_product_id } = req.query;
    if (!parent_product_id) return res.status(400).json({ error: 'parent_product_id is required' });
    
    const result = await tenantQuery(`SELECT * FROM product_components WHERE tenant_id=$1 AND parent_product_id=$2`, [tenant_id, parent_product_id], tenant_id);
    return res.json({ components: result.rows });
});

router.post('/components', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        parent_product_id: z.string().uuid(),
        component_product_id: z.string().uuid(),
        quantity: z.number().positive()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const recipeId = uuidv4();
    await tenantQuery(
        `INSERT INTO product_components (recipe_id, tenant_id, parent_product_id, component_product_id, quantity)
         VALUES ($1,$2,$3,$4,$5)`,
        [recipeId, tenant_id, d.parent_product_id, d.component_product_id, d.quantity],
        tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'inventory.create_component', entityType: 'product_components', entityId: recipeId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ recipe_id: recipeId });
});

// -----------------------------------------------------------------------------
// STOCK TRANSFERS
// -----------------------------------------------------------------------------
router.post('/transfers', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        from_terminal_id: z.string().uuid(),
        to_terminal_id: z.string().uuid(),
        items: z.array(z.object({
            product_id: z.string().uuid(),
            quantity: z.number().int().positive()
        })).min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const transferId = uuidv4();

    await tenantTransaction(async (client) => {
        await client.query(
            `INSERT INTO stock_transfers (transfer_id, tenant_id, from_terminal_id, to_terminal_id, status)
             VALUES ($1,$2,$3,$4,'pending')`,
            [transferId, tenant_id, d.from_terminal_id, d.to_terminal_id]
        );
        for (const item of d.items) {
            await client.query(
                `INSERT INTO stock_transfer_items (item_id, tenant_id, transfer_id, product_id, quantity)
                 VALUES ($1,$2,$3,$4,$5)`,
                [uuidv4(), tenant_id, transferId, item.product_id, item.quantity]
            );
        }
    }, tenant_id);

    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'inventory.create_transfer', entityType: 'stock_transfers', entityId: transferId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ transfer_id: transferId });
});

router.put('/transfers/:id/status', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected', 'completed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await tenantQuery(`UPDATE stock_transfers SET status=$1 WHERE transfer_id=$2 AND tenant_id=$3 RETURNING *`, [status, req.params.id, tenant_id], tenant_id);
    if (!result.rows[0]) return res.status(404).json({ error: 'Transfer not found' });
    
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'inventory.update_transfer', entityType: 'stock_transfers', entityId: req.params.id, newValue: { status }, ipAddress: req.ip });
    return res.json({ message: 'Status updated' });
});

module.exports = router;
""",
    "tax.js": """'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, standardLimiter);

router.get('/groups', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT * FROM tax_groups WHERE tenant_id=$1`, [tenant_id], tenant_id);
    return res.json({ groups: result.rows });
});

router.post('/groups', requireRole('admin'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const groupId = uuidv4();
    await tenantQuery(`INSERT INTO tax_groups (group_id, tenant_id, name) VALUES ($1,$2,$3)`, [groupId, tenant_id, name], tenant_id);
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'tax.create_group', entityType: 'tax_groups', entityId: groupId, newValue: { name }, ipAddress: req.ip });
    return res.status(201).json({ group_id: groupId });
});

router.get('/rates', async (req, res) => {
    const { tenant_id } = req.user;
    const { group_id } = req.query;
    let query = `SELECT * FROM tax_rates WHERE tenant_id=$1`;
    let params = [tenant_id];
    if (group_id) {
        query += ` AND group_id=$2`;
        params.push(group_id);
    }
    const result = await tenantQuery(query, params, tenant_id);
    return res.json({ rates: result.rows });
});

router.post('/rates', requireRole('admin'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        group_id: z.string().uuid(),
        name: z.string().min(1),
        percentage: z.number().nonnegative()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const rateId = uuidv4();
    await tenantQuery(
        `INSERT INTO tax_rates (rate_id, tenant_id, group_id, name, percentage) VALUES ($1,$2,$3,$4,$5)`,
        [rateId, tenant_id, d.group_id, d.name, d.percentage], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'tax.create_rate', entityType: 'tax_rates', entityId: rateId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ rate_id: rateId });
});

module.exports = router;
""",
    "transactions.js": """'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, standardLimiter);

const createSchema = z.object({
    customer_id: z.string().uuid().optional().nullable(),
    total: z.number().nonnegative(),
    valid_until: z.string().optional().nullable(),
    due_date: z.string().optional().nullable(),
    items: z.array(z.any())
});

// Quotes
router.get('/quotes', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT * FROM quotes WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenant_id], tenant_id);
    return res.json({ quotes: result.rows });
});

router.post('/quotes', async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;
    const quoteId = uuidv4();
    
    await tenantQuery(
        `INSERT INTO quotes (quote_id, tenant_id, customer_id, total, valid_until, items_json) VALUES ($1,$2,$3,$4,$5,$6)`,
        [quoteId, tenant_id, d.customer_id||null, d.total, d.valid_until||null, JSON.stringify(d.items)], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'transaction.create_quote', entityType: 'quotes', entityId: quoteId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ quote_id: quoteId });
});

// Invoices
router.get('/invoices', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenant_id], tenant_id);
    return res.json({ invoices: result.rows });
});

router.post('/invoices', async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;
    const invoiceId = uuidv4();
    
    await tenantQuery(
        `INSERT INTO invoices (invoice_id, tenant_id, customer_id, total, due_date, items_json) VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, tenant_id, d.customer_id||null, d.total, d.due_date||null, JSON.stringify(d.items)], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'transaction.create_invoice', entityType: 'invoices', entityId: invoiceId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ invoice_id: invoiceId });
});

// Expenses
router.get('/expenses', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT * FROM expenses WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenant_id], tenant_id);
    return res.json({ expenses: result.rows });
});

router.post('/expenses', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        category: z.string().min(1),
        amount: z.number().nonnegative(),
        description: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;
    const expenseId = uuidv4();
    
    await tenantQuery(
        `INSERT INTO expenses (expense_id, tenant_id, user_id, category, amount, description) VALUES ($1,$2,$3,$4,$5,$6)`,
        [expenseId, tenant_id, user_id, d.category, d.amount, d.description||null], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'transaction.create_expense', entityType: 'expenses', entityId: expenseId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ expense_id: expenseId });
});

module.exports = router;
""",
    "crm.js": """'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, standardLimiter);

router.get('/suppliers', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT * FROM suppliers WHERE tenant_id=$1`, [tenant_id], tenant_id);
    return res.json({ suppliers: result.rows });
});

router.post('/suppliers', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        name: z.string().min(1),
        contact_phone: z.string().optional(),
        contact_email: z.string().email().optional(),
        address: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const supplierId = uuidv4();
    await tenantQuery(
        `INSERT INTO suppliers (supplier_id, tenant_id, name, contact_phone, contact_email, address) VALUES ($1,$2,$3,$4,$5,$6)`,
        [supplierId, tenant_id, d.name, d.contact_phone||null, d.contact_email||null, d.address||null], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'crm.create_supplier', entityType: 'suppliers', entityId: supplierId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ supplier_id: supplierId });
});

// Loyalty endpoints could be added here

module.exports = router;
""",
    "shift.js": """'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, standardLimiter);

router.get('/reports', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT * FROM shift_reports WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenant_id], tenant_id);
    return res.json({ reports: result.rows });
});

router.post('/reports', async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        terminal_id: z.string().uuid(),
        start_time: z.string(),
        end_time: z.string().optional().nullable(),
        expected_cash: z.number().nonnegative(),
        actual_cash: z.number().nonnegative().optional().nullable(),
        difference: z.number().optional().nullable(),
        report_type: z.enum(['X', 'Z'])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const reportId = uuidv4();
    await tenantQuery(
        `INSERT INTO shift_reports (report_id, tenant_id, terminal_id, user_id, start_time, end_time, expected_cash, actual_cash, difference, report_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [reportId, tenant_id, d.terminal_id, user_id, d.start_time, d.end_time||null, d.expected_cash, d.actual_cash||null, d.difference||null, d.report_type], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'shift.create_report', entityType: 'shift_reports', entityId: reportId, newValue: d, ipAddress: req.ip });
    return res.status(201).json({ report_id: reportId });
});

module.exports = router;
""",
    "integrations.js": """'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, standardLimiter);

router.get('/', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(`SELECT integration_id, provider, created_at FROM tenant_integrations WHERE tenant_id=$1`, [tenant_id], tenant_id);
    return res.json({ integrations: result.rows });
});

router.post('/', requireRole('admin'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        provider: z.string().min(1),
        api_key: z.string().optional(),
        config: z.any().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const integrationId = uuidv4();
    await tenantQuery(
        `INSERT INTO tenant_integrations (integration_id, tenant_id, provider, api_key, config_json) VALUES ($1,$2,$3,$4,$5)`,
        [integrationId, tenant_id, d.provider, d.api_key||null, d.config ? JSON.stringify(d.config) : '{}'], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'integrations.create', entityType: 'tenant_integrations', entityId: integrationId, newValue: { provider: d.provider }, ipAddress: req.ip });
    return res.status(201).json({ integration_id: integrationId });
});

// Mock M-Pesa STK push
router.post('/mpesa/stkpush', async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const schema = z.object({
        phone: z.string().min(1),
        amount: z.number().positive(),
        receipt_id: z.string().uuid().optional().nullable()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const txId = uuidv4();
    await tenantQuery(
        `INSERT INTO mpesa_transactions (id, tenant_id, receipt_id, phone, amount, checkout_request_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [txId, tenant_id, d.receipt_id||null, d.phone, d.amount, `ws_CO_${Date.now()}`], tenant_id
    );
    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'mpesa.stkpush', entityType: 'mpesa_transactions', entityId: txId, newValue: d, ipAddress: req.ip });
    return res.status(202).json({ message: 'STK push initiated', transaction_id: txId });
});

module.exports = router;
"""
}

for filename, content in routes.items():
    path = os.path.join(ROUTES_DIR, filename)
    with open(path, "w") as f:
        f.write(content)

print("Generated all 6 backend route files successfully.")
