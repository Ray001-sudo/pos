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
