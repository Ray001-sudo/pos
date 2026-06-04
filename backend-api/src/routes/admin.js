'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');

const { adminQuery, tenantQuery, tenantTransaction } = require('../models/db');
const { requireAuth, requireSuperadmin, revokeAllTenantSessions } = require('../middleware/auth');
const { adminLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, requireSuperadmin, adminLimiter);

// =============================================================================
// GET /api/v1/admin/tenants — list all tenants with status summary
// =============================================================================
router.get('/tenants', async (req, res) => {
    const { page = 1, limit = 50, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await adminQuery(
        `SELECT t.tenant_id, t.business_name, t.business_category, t.owner_email,
                t.account_status, t.days_overdue, t.payment_due_date,
                t.last_cloud_handshake, t.subscription_plan, t.created_at,
                f.module_restaurant, f.module_pharmacy, f.module_gym,
                f.module_salon, f.module_hotel, f.module_wholesale,
                f.module_ai_analytics, f.module_multi_terminal
         FROM tenants t
         LEFT JOIN tenant_feature_flags f ON f.tenant_id = t.tenant_id
         WHERE ($1::text IS NULL OR t.account_status::text = $1)
           AND ($2::text IS NULL OR t.business_name ILIKE '%' || $2 || '%'
                                 OR t.owner_email ILIKE '%' || $2 || '%')
         ORDER BY t.created_at DESC
         LIMIT $3 OFFSET $4`,
        [status || null, search || null, parseInt(limit), offset]
    );

    const countResult = await adminQuery(
        `SELECT COUNT(*) FROM tenants
         WHERE ($1::text IS NULL OR account_status::text = $1)`,
        [status || null]
    );

    return res.json({
        tenants: result.rows,
        total:   parseInt(countResult.rows[0].count),
        page:    parseInt(page),
        limit:   parseInt(limit)
    });
});

// =============================================================================
// POST /api/v1/admin/tenants — provision a new tenant
// =============================================================================
const createTenantSchema = z.object({
    business_name:      z.string().min(2).max(255),
    business_category:  z.enum(['retail','wholesale','restaurant','pharmacy','salon','gym','hotel','cafe']),
    owner_email:        z.string().email(),
    owner_phone:        z.string().optional(),
    subscription_plan:  z.string().default('starter'),
    admin_username:     z.string().min(3).max(100),
    admin_password:     z.string().min(10).max(255),
    modules:            z.object({
        restaurant:     z.boolean().default(false),
        pharmacy:       z.boolean().default(false),
        gym:            z.boolean().default(false),
        salon:          z.boolean().default(false),
        hotel:          z.boolean().default(false),
        wholesale:      z.boolean().default(false),
        ai_analytics:   z.boolean().default(false),
        multi_terminal: z.boolean().default(false)
    }).optional()
});

router.post('/tenants', async (req, res) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const d = parsed.data;
    const tenantId = uuidv4();
    const adminUserId = uuidv4();
    const terminalId = uuidv4();

    // Hash admin password with bcrypt (12 rounds minimum)
    const passwordHash = await bcrypt.hash(d.admin_password, 12);

    await adminQuery('BEGIN', []);

    try {
        // 1. Create tenant
        await adminQuery(
            `INSERT INTO tenants
                (tenant_id, business_name, business_category, owner_email, owner_phone, subscription_plan, account_status)
             VALUES ($1,$2,$3,$4,$5,$6,'active')`,
            [tenantId, d.business_name, d.business_category, d.owner_email, d.owner_phone || null, d.subscription_plan]
        );

        // 2. Create feature flags
        const mods = d.modules || {};
        await adminQuery(
            `INSERT INTO tenant_feature_flags
                (flag_id, tenant_id, module_restaurant, module_pharmacy, module_gym,
                 module_salon, module_hotel, module_wholesale, module_ai_analytics, module_multi_terminal)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [uuidv4(), tenantId,
             mods.restaurant || false, mods.pharmacy || false, mods.gym || false,
             mods.salon || false, mods.hotel || false, mods.wholesale || false,
             mods.ai_analytics || false, mods.multi_terminal || false]
        );

        // 3. Create default admin user
        await adminQuery(
            `INSERT INTO users (user_id, tenant_id, username, password_hash, role)
             VALUES ($1,$2,$3,$4,'admin')`,
            [adminUserId, tenantId, d.admin_username, passwordHash]
        );

        // 4. Register a default terminal
        await adminQuery(
            `INSERT INTO terminals (terminal_id, tenant_id, terminal_name, is_active)
             VALUES ($1,$2,'Main Terminal',true)`,
            [terminalId, tenantId]
        );

        await writeAuditLog({
            tenantId:   tenantId,
            userId:     req.user.user_id,
            action:     'tenant.create',
            entityType: 'tenant',
            entityId:   tenantId,
            newValue:   { business_name: d.business_name, owner_email: d.owner_email },
            ipAddress:  req.ip,
            isSuperadmin: true
        });

        return res.status(201).json({
            tenant_id:  tenantId,
            admin_user_id: adminUserId,
            terminal_id:   terminalId
        });
    } catch (err) {
        throw err; // rolled back by adminQuery's try/catch
    }
});

// =============================================================================
// PUT /api/v1/admin/tenants/:id/status — change account status
// =============================================================================
router.put('/tenants/:id/status', async (req, res) => {
    const tenantId = req.params.id;
    const { status, reason } = req.body;

    const validStatuses = ['active', 'past_due', 'suspended', 'offline_timeout', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
    }

    const old = await adminQuery(
        `SELECT account_status FROM tenants WHERE tenant_id = $1`, [tenantId]
    );
    if (!old.rows[0]) return res.status(404).json({ error: 'Tenant not found' });

    await adminQuery(
        `UPDATE tenants SET account_status = $1::account_status, updated_at = NOW() WHERE tenant_id = $2`,
        [status, tenantId]
    );

    // If suspending, revoke all active sessions immediately
    if (status === 'suspended' || status === 'cancelled') {
        await revokeAllTenantSessions(tenantId);
    }

    // Record billing event for suspension/reactivation
    if (['suspended', 'active'].includes(status)) {
        const eventType = status === 'suspended' ? 'suspended' : 'reactivated';
        await adminQuery(
            `INSERT INTO billing_events (event_id, tenant_id, event_type, notes)
             VALUES ($1,$2,$3,$4)`,
            [uuidv4(), tenantId, eventType, reason || null]
        );
    }

    await writeAuditLog({
        tenantId:    tenantId,
        userId:      req.user.user_id,
        action:      `tenant.status_change`,
        entityType:  'tenant',
        entityId:    tenantId,
        oldValue:    { account_status: old.rows[0].account_status },
        newValue:    { account_status: status, reason },
        ipAddress:   req.ip,
        isSuperadmin: true
    });

    return res.json({ message: `Tenant status updated to ${status}`, tenant_id: tenantId });
});

// =============================================================================
// PUT /api/v1/admin/tenants/:id/modules — update feature flags
// =============================================================================
router.put('/tenants/:id/modules', async (req, res) => {
    const tenantId = req.params.id;
    const schema = z.object({
        module_restaurant:    z.boolean().optional(),
        module_pharmacy:      z.boolean().optional(),
        module_gym:           z.boolean().optional(),
        module_salon:         z.boolean().optional(),
        module_hotel:         z.boolean().optional(),
        module_wholesale:     z.boolean().optional(),
        module_ai_analytics:  z.boolean().optional(),
        module_multi_terminal: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const d = parsed.data;
    const fields = Object.entries(d);
    if (fields.length === 0) return res.status(400).json({ error: 'No module flags provided' });

    const setClauses = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const values = [tenantId, ...fields.map(([, v]) => v)];

    await adminQuery(
        `UPDATE tenant_feature_flags SET ${setClauses}, updated_at = NOW() WHERE tenant_id = $1`,
        values
    );

    await writeAuditLog({
        tenantId:    tenantId,
        userId:      req.user.user_id,
        action:      'tenant.modules_update',
        entityType:  'tenant',
        entityId:    tenantId,
        newValue:    d,
        ipAddress:   req.ip,
        isSuperadmin: true
    });

    return res.json({ message: 'Module flags updated', tenant_id: tenantId });
});

// =============================================================================
// GET /api/v1/admin/tenants/:id/billing — billing history
// =============================================================================
router.get('/tenants/:id/billing', async (req, res) => {
    const result = await adminQuery(
        `SELECT * FROM billing_events WHERE tenant_id = $1 ORDER BY event_timestamp DESC LIMIT 100`,
        [req.params.id]
    );
    return res.json({ events: result.rows });
});

// =============================================================================
// GET /api/v1/admin/tenants/:id/audit — audit log for a tenant
// =============================================================================
router.get('/tenants/:id/audit', async (req, res) => {
    const { page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await adminQuery(
        `SELECT al.*, u.username FROM audit_logs al
         LEFT JOIN users u ON u.user_id = al.user_id
         WHERE al.tenant_id = $1
         ORDER BY al.timestamp DESC
         LIMIT $2 OFFSET $3`,
        [req.params.id, parseInt(limit), offset]
    );
    return res.json({ logs: result.rows });
});

// =============================================================================
// GET /api/v1/admin/stats — platform-wide metrics for dashboard
// =============================================================================
router.get('/stats', async (req, res) => {
    const [tenantStats, salesStats, overdueStats] = await Promise.all([
        adminQuery(
            `SELECT account_status, COUNT(*) as count
             FROM tenants GROUP BY account_status`, []
        ),
        adminQuery(
            `SELECT
                COUNT(*) as total_transactions,
                COALESCE(SUM(grand_total), 0) as total_revenue
             FROM sales_transactions
             WHERE sale_timestamp >= NOW() - INTERVAL '30 days'
               AND NOT is_voided`, []
        ),
        adminQuery(
            `SELECT COUNT(*) as overdue_tenants, AVG(days_overdue) as avg_days_overdue
             FROM tenants WHERE days_overdue > 0`, []
        )
    ]);

    return res.json({
        tenant_status_breakdown: tenantStats.rows,
        last_30_days:            salesStats.rows[0],
        overdue_summary:         overdueStats.rows[0]
    });
});

// =============================================================================
// POST /api/v1/admin/tenants/:id/reset-password — reset admin user password
// =============================================================================
router.post('/tenants/:id/reset-password', async (req, res) => {
    const { user_id, new_password } = req.body;
    if (!user_id || !new_password || new_password.length < 10) {
        return res.status(400).json({ error: 'user_id and new_password (min 10 chars) required' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    const result = await adminQuery(
        `UPDATE users SET password_hash = $1, failed_attempts = 0, locked_until = NULL
         WHERE user_id = $2 AND tenant_id = $3 RETURNING user_id`,
        [hash, user_id, req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found in tenant' });

    await writeAuditLog({
        tenantId:    req.params.id,
        userId:      req.user.user_id,
        action:      'user.password_reset',
        entityType:  'user',
        entityId:    user_id,
        ipAddress:   req.ip,
        isSuperadmin: true
    });

    return res.json({ message: 'Password reset successfully' });
});

module.exports = router;
