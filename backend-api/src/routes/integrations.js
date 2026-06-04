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

const { getMpesaToken } = require('../utils/mpesaAuth');
const axios = require('axios');

// Real M-Pesa STK push
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

    // 1. Initial DB insert (status requested)
    await tenantQuery(
        `INSERT INTO mpesa_transactions (id, tenant_id, receipt_id, phone, amount, checkout_request_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'requested')`,
        [txId, tenant_id, d.receipt_id || null, d.phone, d.amount, null], tenant_id
    );

    await writeAuditLog({ tenantId: tenant_id, userId: user_id, action: 'mpesa.stkpush.init', entityType: 'mpesa_transactions', entityId: txId, newValue: d, ipAddress: req.ip });

    try {
        // 2. Fetch OAuth Token
        const token = await getMpesaToken();

        // 3. Perform STK Push Request
        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
        
        const baseUrl = process.env.MPESA_ENV === 'production' 
            ? 'https://api.safaricom.co.ke' 
            : 'https://sandbox.safaricom.co.ke';

        const stkPayload = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: d.amount,
            PartyA: d.phone,
            PartyB: shortcode,
            PhoneNumber: d.phone,
            CallBackURL: `${process.env.PUBLIC_API_URL}/api/v1/integrations/mpesa/callback`,
            AccountReference: txId,
            TransactionDesc: "POS Payment"
        };

        const stkRes = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, stkPayload, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        const checkoutRequestId = stkRes.data.CheckoutRequestID;

        // 4. Update DB with pending status and CheckoutRequestID
        await tenantQuery(
            `UPDATE mpesa_transactions SET status = 'pending', checkout_request_id = $1 WHERE id = $2 AND tenant_id = $3`,
            [checkoutRequestId, txId, tenant_id], tenant_id
        );

        return res.status(202).json({ message: 'STK push initiated', transaction_id: txId, checkout_request_id: checkoutRequestId });
    } catch (err) {
        console.error('M-Pesa STK push error:', err.response?.data || err.message);
        await tenantQuery(
            `UPDATE mpesa_transactions SET status = 'failed' WHERE id = $1 AND tenant_id = $2`,
            [txId, tenant_id], tenant_id
        );
        return res.status(502).json({ error: 'Failed to initiate M-Pesa transaction' });
    }
});

module.exports = router;
