'use strict';

const express = require('express');
const crypto  = require('crypto');
const { z }   = require('zod');

const { tenantQuery }  = require('../models/db');
const { requireAuth }  = require('../middleware/auth');
const { syncLimiter, verifyHmacSignature } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

// =============================================================================
// LICENSE ROUTES
// =============================================================================
const licenseRouter = express.Router();

// GET /api/v1/license/check
// Called by C++ client on every startup; returns account status and a signed handshake token
licenseRouter.get('/check', requireAuth, async (req, res) => {
    const { tenant_id } = req.user;

    const result = await tenantQuery(
        `SELECT t.account_status, t.days_overdue, t.payment_due_date,
                f.module_restaurant, f.module_pharmacy, f.module_gym, f.module_salon,
                f.module_hotel, f.module_wholesale, f.module_ai_analytics, f.module_multi_terminal
         FROM tenants t
         LEFT JOIN tenant_feature_flags f ON f.tenant_id = t.tenant_id
         WHERE t.tenant_id = $1`,
        [tenant_id],
        tenant_id
    );

    if (!result.rows[0]) {
        return res.status(404).json({ error: 'Tenant not found' });
    }

    const row = result.rows[0];

    // Generate signed handshake token — issued on every heartbeat for active/past_due accounts
    let handshakeToken = null;
    if (row.account_status === 'active' || row.account_status === 'past_due') {
        handshakeToken = generateHandshakeToken(tenant_id);
    }

    // Update last_cloud_handshake timestamp
    await tenantQuery(
        `UPDATE tenants SET last_cloud_handshake = NOW() WHERE tenant_id = $1`,
        [tenant_id],
        tenant_id
    );

    return res.json({
        account_status: row.account_status,
        days_overdue:   row.days_overdue,
        modules: {
            restaurant:    row.module_restaurant,
            pharmacy:      row.module_pharmacy,
            gym:           row.module_gym,
            salon:         row.module_salon,
            hotel:         row.module_hotel,
            wholesale:     row.module_wholesale,
            ai_analytics:  row.module_ai_analytics,
            multi_terminal: row.module_multi_terminal
        },
        handshake_token: handshakeToken
    });
});

// GET /api/v1/license/modules
licenseRouter.get('/modules', requireAuth, async (req, res) => {
    const { tenant_id } = req.user;

    const result = await tenantQuery(
        `SELECT * FROM tenant_feature_flags WHERE tenant_id = $1`,
        [tenant_id],
        tenant_id
    );

    return res.json(result.rows[0] || {});
});

/**
 * Generate a signed handshake token for the C++ client's time-bomb system.
 * valid_until = now + 14 days.
 * Signed with HMAC-SHA256 using server secret — client cannot forge or extend.
 */
function generateHandshakeToken(tenantId) {
    const issuedAt  = Math.floor(Date.now() / 1000);
    const validUntil = issuedAt + 14 * 86400;   // 14 days
    const secret = process.env.HANDSHAKE_HMAC_SECRET;

    if (!secret) throw new Error('HANDSHAKE_HMAC_SECRET not configured');

    const payload = `${issuedAt}:${validUntil}:${tenantId}`;
    const signature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    return { issued_at: issuedAt, valid_until: validUntil, tenant_id: tenantId, signature };
}

// =============================================================================
// SYNC ROUTES
// =============================================================================
const syncRouter = express.Router();

// POST /api/v1/sync/heartbeat
const { verifyHmacSignature: verifyHmac } = require('../middleware/errorHandler');
syncRouter.post('/heartbeat', requireAuth, async (req, res) => {
    const { tenant_id } = req.user;

    const tenantResult = await tenantQuery(
        `SELECT account_status, days_overdue, payment_due_date FROM tenants WHERE tenant_id = $1`,
        [tenant_id],
        tenant_id
    );

    const tenant = tenantResult.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Update handshake timestamp on every heartbeat
    await tenantQuery(
        `UPDATE tenants SET last_cloud_handshake = NOW() WHERE tenant_id = $1`,
        [tenant_id],
        tenant_id
    );

    let handshakeToken = null;
    if (tenant.account_status === 'active' || tenant.account_status === 'past_due') {
        handshakeToken = generateHandshakeToken(tenant_id);
    }

    const modulesResult = await tenantQuery(
        `SELECT * FROM tenant_feature_flags WHERE tenant_id = $1`,
        [tenant_id],
        tenant_id
    );
    const modules = modulesResult.rows[0] || {};

    return res.json({
        account_status:  tenant.account_status,
        days_overdue:    tenant.days_overdue,
        payment_due_date: tenant.payment_due_date,
        modules,
        handshake_token: handshakeToken
    });
});

// POST /api/v1/sync/transactions — bulk receive unsynced local transactions
const transactionBatchSchema = z.object({
    transactions: z.array(z.object({
        receipt_id:     z.string().uuid(),
        terminal_id:    z.string().uuid(),
        cashier_id:     z.string().uuid(),
        subtotal:       z.number().nonnegative(),
        tax_total:      z.number().nonnegative(),
        discount_total: z.number().nonnegative(),
        grand_total:    z.number().nonnegative(),
        payment_method: z.enum(['cash', 'card', 'mobile_money', 'split']),
        sale_timestamp: z.string(),
        is_voided:      z.boolean(),
        void_reason:    z.string().nullable().optional(),
        items:          z.array(z.object({
            product_id: z.string().uuid(),
            quantity:   z.number().int().positive(),
            unit_price: z.number().nonnegative(),
            line_total: z.number().nonnegative()
        }))
    })).max(50)  // batch cap per request
});

syncRouter.post('/transactions', requireAuth, async (req, res) => {
    const { tenant_id } = req.user;
    const parsed = transactionBatchSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }

    const { transactions } = parsed.data;
    const accepted = [];
    const rejected = [];

    const { tenantTransaction } = require('../models/db');
    const { v4: uuidv4 } = require('uuid');

    for (const tx of transactions) {
        try {
            await tenantTransaction(async (client) => {
                // Upsert transaction (idempotent — re-sent duplicates are ignored)
                await client.query(
                    `INSERT INTO sales_transactions
                        (receipt_id, tenant_id, terminal_id, cashier_id, subtotal, tax_total,
                         discount_total, grand_total, payment_method, sale_timestamp, is_voided, void_reason)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     ON CONFLICT (receipt_id) DO NOTHING`,
                    [
                        tx.receipt_id, tenant_id, tx.terminal_id, tx.cashier_id,
                        tx.subtotal, tx.tax_total, tx.discount_total, tx.grand_total,
                        tx.payment_method, tx.sale_timestamp, tx.is_voided, tx.void_reason || null
                    ]
                );

                // Insert sale items
                for (const item of tx.items) {
                    await client.query(
                        `INSERT INTO sale_items (item_id, receipt_id, tenant_id, product_id, quantity, unit_price, line_total)
                         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
                        [uuidv4(), tx.receipt_id, tenant_id, item.product_id, item.quantity, item.unit_price, item.line_total]
                    );
                    // Decrement stock
                    await client.query(
                        `UPDATE products SET stock_quantity = GREATEST(0, stock_quantity - $1)
                         WHERE product_id = $2 AND tenant_id = $3`,
                        [item.quantity, item.product_id, tenant_id]
                    );
                }
            }, tenant_id);

            accepted.push(tx.receipt_id);
        } catch (err) {
            rejected.push({ receipt_id: tx.receipt_id, reason: err.message });
        }
    }

    return res.json({ accepted, rejected });
});

// GET /api/v1/sync/products — delta sync of products
syncRouter.get('/products', requireAuth, async (req, res) => {
    const { tenant_id } = req.user;
    const since = req.query.since; // ISO-8601 timestamp

    const result = await tenantQuery(
        `SELECT product_id, name, sku, barcode, price, cost_price, stock_quantity,
                category, unit, tax_rate, is_active, batch_number, expiry_date,
                requires_prescription, updated_at
         FROM products
         WHERE tenant_id = $1
           AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
         ORDER BY updated_at ASC
         LIMIT 500`,
        [tenant_id, since || null],
        tenant_id
    );

    return res.json({ products: result.rows, synced_at: new Date().toISOString() });
});

module.exports = { licenseRouter, syncRouter };
