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
