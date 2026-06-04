'use strict';

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
