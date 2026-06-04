'use strict';

const express = require('express');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');
const { tenantQuery, tenantTransaction } = require('../models/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

// =============================================================================
// PRODUCTS ROUTER
// =============================================================================
const productsRouter = express.Router();
productsRouter.use(requireAuth, standardLimiter);

const productSchema = z.object({
    name:                   z.string().min(1).max(255),
    sku:                    z.string().max(100).optional(),
    barcode:                z.string().max(100).optional(),
    price:                  z.number().nonnegative(),
    cost_price:             z.number().nonnegative().optional(),
    stock_quantity:         z.number().int().nonnegative().default(0),
    category:               z.string().max(100).optional(),
    unit:                   z.string().max(50).optional(),
    tax_rate:               z.number().nonnegative().default(0),
    tax_group_id:           z.string().uuid().optional().nullable(),
    reorder_level:          z.number().int().nonnegative().default(0),
    batch_number:           z.string().max(100).optional(),
    expiry_date:            z.string().optional().nullable(),
    requires_prescription:  z.boolean().default(false)
});

// GET /api/v1/products
productsRouter.get('/', async (req, res) => {
    const { tenant_id } = req.user;
    const { category, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await tenantQuery(
        `SELECT * FROM products
         WHERE tenant_id = $1 AND is_active = true
           AND ($2::text IS NULL OR category = $2)
           AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR barcode = $3 OR sku ILIKE '%' || $3 || '%')
         ORDER BY name ASC
         LIMIT $4 OFFSET $5`,
        [tenant_id, category || null, search || null, parseInt(limit), offset],
        tenant_id
    );

    const countResult = await tenantQuery(
        `SELECT COUNT(*) FROM products WHERE tenant_id = $1 AND is_active = true`,
        [tenant_id], tenant_id
    );

    return res.json({
        products: result.rows,
        total:    parseInt(countResult.rows[0].count),
        page:     parseInt(page),
        limit:    parseInt(limit)
    });
});

// POST /api/v1/products
productsRouter.post('/', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const productId = uuidv4();

    await tenantQuery(
        `INSERT INTO products (product_id, tenant_id, name, sku, barcode, price, cost_price,
          stock_quantity, reorder_level, category, unit, tax_rate, tax_group_id, batch_number, expiry_date, requires_prescription)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [productId, tenant_id, d.name, d.sku||null, d.barcode||null, d.price, d.cost_price||null,
         d.stock_quantity, d.reorder_level, d.category||null, d.unit||null, d.tax_rate, d.tax_group_id||null,
         d.batch_number||null, d.expiry_date||null, d.requires_prescription],
        tenant_id
    );

    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'product.create',
        entityType: 'product', entityId: productId, newValue: d, ipAddress: req.ip });

    return res.status(201).json({ product_id: productId });
});

// PUT /api/v1/products/:id
productsRouter.put('/:id', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const productId = req.params.id;
    const parsed = productSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const old = await tenantQuery(`SELECT * FROM products WHERE product_id=$1 AND tenant_id=$2`,
        [productId, tenant_id], tenant_id);
    if (!old.rows[0]) return res.status(404).json({ error: 'Product not found' });

    const d = parsed.data;
    await tenantQuery(
        `UPDATE products SET
            name=$1, sku=$2, barcode=$3, price=$4, cost_price=$5, stock_quantity=$6, reorder_level=$7,
            category=$8, unit=$9, tax_rate=$10, tax_group_id=$11, batch_number=$12, expiry_date=$13,
            requires_prescription=$14, updated_at=NOW()
         WHERE product_id=$15 AND tenant_id=$16`,
        [d.name??old.rows[0].name, d.sku??old.rows[0].sku, d.barcode??old.rows[0].barcode,
         d.price??old.rows[0].price, d.cost_price??old.rows[0].cost_price,
         d.stock_quantity??old.rows[0].stock_quantity, d.reorder_level??old.rows[0].reorder_level, d.category??old.rows[0].category,
         d.unit??old.rows[0].unit, d.tax_rate??old.rows[0].tax_rate, d.tax_group_id??old.rows[0].tax_group_id,
         d.batch_number??old.rows[0].batch_number, d.expiry_date??old.rows[0].expiry_date,
         d.requires_prescription??old.rows[0].requires_prescription,
         productId, tenant_id],
        tenant_id
    );

    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'product.update',
        entityType: 'product', entityId: productId, oldValue: old.rows[0], newValue: d, ipAddress: req.ip });

    return res.json({ message: 'Product updated' });
});

// DELETE /api/v1/products/:id — soft delete only
productsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const productId = req.params.id;

    const result = await tenantQuery(
        `UPDATE products SET is_active=false, updated_at=NOW() WHERE product_id=$1 AND tenant_id=$2 RETURNING *`,
        [productId, tenant_id], tenant_id
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });

    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'product.deactivate',
        entityType: 'product', entityId: productId, oldValue: result.rows[0], ipAddress: req.ip });

    return res.json({ message: 'Product deactivated' });
});

// GET /api/v1/products/expiring — Pharmacy module
productsRouter.get('/expiring', async (req, res) => {
    const { tenant_id } = req.user;
    const days = parseInt(req.query.days || '30');

    const result = await tenantQuery(
        `SELECT * FROM products
         WHERE tenant_id=$1 AND is_active=true AND expiry_date IS NOT NULL
           AND expiry_date <= (CURRENT_DATE + $2 * INTERVAL '1 day')
         ORDER BY expiry_date ASC`,
        [tenant_id, days], tenant_id
    );

    return res.json({ expiring_products: result.rows });
});

// =============================================================================
// SALES ROUTER
// =============================================================================
const salesRouter = express.Router();
salesRouter.use(requireAuth, standardLimiter);

// GET /api/v1/sales
salesRouter.get('/', async (req, res) => {
    const { tenant_id } = req.user;
    const { from, to, cashier_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await tenantQuery(
        `SELECT s.*, u.username as cashier_name
         FROM sales_transactions s
         LEFT JOIN users u ON u.user_id = s.cashier_id
         WHERE s.tenant_id=$1
           AND ($2::timestamptz IS NULL OR s.sale_timestamp >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR s.sale_timestamp <= $3::timestamptz)
           AND ($4::uuid IS NULL OR s.cashier_id = $4::uuid)
         ORDER BY s.sale_timestamp DESC
         LIMIT $5 OFFSET $6`,
        [tenant_id, from||null, to||null, cashier_id||null, parseInt(limit), offset],
        tenant_id
    );

    return res.json({ sales: result.rows, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/v1/sales/:receipt_id
salesRouter.get('/:receipt_id', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(
        `SELECT s.*, json_agg(si.*) as items
         FROM sales_transactions s
         LEFT JOIN sale_items si ON si.receipt_id = s.receipt_id
         WHERE s.receipt_id=$1 AND s.tenant_id=$2
         GROUP BY s.receipt_id`,
        [req.params.receipt_id, tenant_id], tenant_id
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Transaction not found' });
    return res.json(result.rows[0]);
});

// POST /api/v1/sales/void
salesRouter.post('/void', requireRole('manager'), async (req, res) => {
    const { tenant_id, user_id } = req.user;
    const { receipt_id, void_reason } = req.body;
    if (!receipt_id || !void_reason) return res.status(400).json({ error: 'receipt_id and void_reason required' });

    const result = await tenantQuery(
        `UPDATE sales_transactions SET is_voided=true, void_reason=$1
         WHERE receipt_id=$2 AND tenant_id=$3 AND is_voided=false RETURNING *`,
        [void_reason, receipt_id, tenant_id], tenant_id
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Transaction not found or already voided' });

    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'sale.void',
        entityType: 'sale', entityId: receipt_id,
        newValue: { void_reason }, ipAddress: req.ip });

    return res.json({ message: 'Transaction voided', receipt_id });
});

// =============================================================================
// RESTAURANT ROUTER
// =============================================================================
const restaurantRouter = express.Router();
restaurantRouter.use(requireAuth, standardLimiter);

restaurantRouter.get('/tables', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(
        `SELECT * FROM restaurant_tables WHERE tenant_id=$1 ORDER BY table_number`,
        [tenant_id], tenant_id
    );
    return res.json({ tables: result.rows });
});

restaurantRouter.put('/tables/:id/status', async (req, res) => {
    const { tenant_id } = req.user;
    const { status } = req.body;
    const validStatuses = ['available', 'occupied', 'reserved', 'cleaning'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await tenantQuery(
        `UPDATE restaurant_tables SET status=$1 WHERE table_id=$2 AND tenant_id=$3 RETURNING *`,
        [status, req.params.id, tenant_id], tenant_id
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Table not found' });
    return res.json(result.rows[0]);
});

restaurantRouter.post('/kot', async (req, res) => {
    const { tenant_id } = req.user;
    const { table_id, items } = req.body;
    if (!table_id || !items) return res.status(400).json({ error: 'table_id and items required' });

    const kotId = uuidv4();
    await tenantQuery(
        `INSERT INTO kitchen_orders (kot_id, tenant_id, table_id, items_json, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [kotId, tenant_id, table_id, JSON.stringify(items)], tenant_id
    );
    return res.status(201).json({ kot_id: kotId });
});

restaurantRouter.put('/kot/:id/status', async (req, res) => {
    const { tenant_id } = req.user;
    const { status } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'served'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await tenantQuery(
        `UPDATE kitchen_orders SET status=$1 WHERE kot_id=$2 AND tenant_id=$3 RETURNING *`,
        [status, req.params.id, tenant_id], tenant_id
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'KOT not found' });
    return res.json(result.rows[0]);
});

// =============================================================================
// MEMBERSHIPS ROUTER
// =============================================================================
const membershipsRouter = express.Router();
membershipsRouter.use(requireAuth, standardLimiter);

membershipsRouter.get('/', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(
        `SELECT m.*, c.full_name, c.phone FROM memberships m
         JOIN customers c ON c.customer_id = m.customer_id
         WHERE m.tenant_id=$1 ORDER BY m.end_date DESC`,
        [tenant_id], tenant_id
    );
    return res.json({ memberships: result.rows });
});

membershipsRouter.post('/', requireRole('manager'), async (req, res) => {
    const { tenant_id } = req.user;
    const schema = z.object({
        customer_id: z.string().uuid(),
        plan_name:   z.string().min(1),
        start_date:  z.string(),
        end_date:    z.string()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { customer_id, plan_name, start_date, end_date } = parsed.data;
    const membershipId = uuidv4();

    await tenantQuery(
        `INSERT INTO memberships (membership_id, tenant_id, customer_id, plan_name, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [membershipId, tenant_id, customer_id, plan_name, start_date, end_date], tenant_id
    );

    return res.status(201).json({ membership_id: membershipId });
});

membershipsRouter.get('/check/:customer_id', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(
        `SELECT * FROM memberships
         WHERE tenant_id=$1 AND customer_id=$2 AND is_active=true AND end_date >= CURRENT_DATE
         ORDER BY end_date DESC LIMIT 1`,
        [tenant_id, req.params.customer_id], tenant_id
    );
    return res.json({ active_membership: result.rows[0] || null });
});

// =============================================================================
// APPOINTMENTS ROUTER
// =============================================================================
const appointmentsRouter = express.Router();
appointmentsRouter.use(requireAuth, standardLimiter);

appointmentsRouter.get('/', async (req, res) => {
    const { tenant_id } = req.user;
    const result = await tenantQuery(
        `SELECT a.*, c.full_name as customer_name, u.username as staff_name
         FROM appointments a
         JOIN customers c ON c.customer_id = a.customer_id
         JOIN users u ON u.user_id = a.staff_id
         WHERE a.tenant_id=$1 AND a.scheduled_at >= NOW()
         ORDER BY a.scheduled_at ASC LIMIT 100`,
        [tenant_id], tenant_id
    );
    return res.json({ appointments: result.rows });
});

appointmentsRouter.post('/', async (req, res) => {
    const { tenant_id } = req.user;
    const schema = z.object({
        customer_id:  z.string().uuid(),
        staff_id:     z.string().uuid(),
        service_name: z.string().min(1),
        scheduled_at: z.string()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const appointmentId = uuidv4();
    const { customer_id, staff_id, service_name, scheduled_at } = parsed.data;

    await tenantQuery(
        `INSERT INTO appointments (appointment_id, tenant_id, customer_id, staff_id, service_name, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [appointmentId, tenant_id, customer_id, staff_id, service_name, scheduled_at], tenant_id
    );

    return res.status(201).json({ appointment_id: appointmentId });
});

appointmentsRouter.put('/:id/status', async (req, res) => {
    const { tenant_id } = req.user;
    const { status } = req.body;
    const validStatuses = ['booked', 'confirmed', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await tenantQuery(
        `UPDATE appointments SET status=$1 WHERE appointment_id=$2 AND tenant_id=$3 RETURNING *`,
        [status, req.params.id, tenant_id], tenant_id
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    return res.json(result.rows[0]);
});

// =============================================================================
// REPORTS ROUTER
// =============================================================================
const reportsRouter = express.Router();
reportsRouter.use(requireAuth, standardLimiter);

reportsRouter.get('/daily-summary', async (req, res) => {
    const { tenant_id } = req.user;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const result = await tenantQuery(
        `SELECT
            COUNT(*) FILTER (WHERE NOT is_voided) AS total_sales,
            COUNT(*) FILTER (WHERE is_voided) AS voided_count,
            COALESCE(SUM(grand_total) FILTER (WHERE NOT is_voided), 0) AS gross_revenue,
            COALESCE(SUM(tax_total) FILTER (WHERE NOT is_voided), 0) AS total_tax,
            COALESCE(SUM(discount_total) FILTER (WHERE NOT is_voided), 0) AS total_discounts,
            payment_method,
            COUNT(*) FILTER (WHERE NOT is_voided) AS count_by_method
         FROM sales_transactions
         WHERE tenant_id=$1 AND DATE(sale_timestamp AT TIME ZONE 'UTC') = $2::date
         GROUP BY payment_method`,
        [tenant_id, date], tenant_id
    );

    return res.json({ date, summary: result.rows });
});

reportsRouter.get('/top-products', async (req, res) => {
    const { tenant_id } = req.user;
    const { from, to, limit = 10 } = req.query;

    const result = await tenantQuery(
        `SELECT p.name, p.sku, p.category,
                SUM(si.quantity) AS total_qty_sold,
                SUM(si.line_total) AS total_revenue
         FROM sale_items si
         JOIN products p ON p.product_id = si.product_id
         JOIN sales_transactions s ON s.receipt_id = si.receipt_id
         WHERE si.tenant_id=$1 AND NOT s.is_voided
           AND ($2::timestamptz IS NULL OR s.sale_timestamp >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR s.sale_timestamp <= $3::timestamptz)
         GROUP BY p.product_id, p.name, p.sku, p.category
         ORDER BY total_qty_sold DESC
         LIMIT $4`,
        [tenant_id, from||null, to||null, parseInt(limit)], tenant_id
    );

    return res.json({ top_products: result.rows });
});

reportsRouter.get('/low-stock', async (req, res) => {
    const { tenant_id } = req.user;
    const threshold = parseInt(req.query.threshold || '10');

    const result = await tenantQuery(
        `SELECT product_id, name, sku, stock_quantity, category, unit
         FROM products
         WHERE tenant_id=$1 AND is_active=true AND stock_quantity <= $2
         ORDER BY stock_quantity ASC`,
        [tenant_id, threshold], tenant_id
    );

    return res.json({ low_stock_products: result.rows, threshold });
});

reportsRouter.get('/ai-insights', async (req, res) => {
    const { tenant_id } = req.user;
    const type = req.query.type;

    const result = await tenantQuery(
        `SELECT insight_id, insight_type, product_id, payload, generated_at
         FROM ai_insights
         WHERE tenant_id=$1
           AND expires_at > NOW()
           AND ($2::text IS NULL OR insight_type::text = $2)
         ORDER BY generated_at DESC
         LIMIT 100`,
        [tenant_id, type||null], tenant_id
    );

    return res.json({ insights: result.rows });
});

module.exports = {
    productsRouter,
    salesRouter,
    restaurantRouter,
    membershipsRouter,
    appointmentsRouter,
    reportsRouter
};
