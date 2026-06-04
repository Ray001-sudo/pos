'use strict';

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
