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
