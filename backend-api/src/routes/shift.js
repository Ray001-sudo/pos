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
