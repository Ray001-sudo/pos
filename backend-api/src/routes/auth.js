'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const { z }   = require('zod');
const { v4: uuidv4 } = require('uuid');

const { tenantQuery, adminQuery } = require('../models/db');
const {
    issueAccessToken, issueRefreshToken,
    verifyAccessToken, revokeAccessToken,
    requireAuth, REFRESH_TOKEN_COOKIE
} = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { writeAuditLog } = require('../services/auditService');
const { getRedisClient } = require('../server');

const router = express.Router();

// =============================================================================
// INPUT SCHEMAS (Zod)
// =============================================================================
const loginSchema = z.object({
    tenant_id: z.string().uuid(),
    username:  z.string().min(1).max(100),
    password:  z.string().min(1).max(255).optional(),
    pin:       z.string().min(4).max(10).optional()
});

// =============================================================================
// POST /api/v1/auth/login
// =============================================================================
router.post('/login', authLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }

    const { tenant_id, username, password, pin } = parsed.data;

    if (!password && !pin) {
        return res.status(400).json({ error: 'Either password or pin must be provided' });
    }

    // Look up user within tenant — always parameterized, never string-concatenated
    const userResult = await tenantQuery(
        `SELECT u.user_id, u.password_hash, u.pin_hash, u.role, u.custom_role_id, u.is_active, u.failed_attempts, u.locked_until,
                t.account_status, t.subscription_plan
         FROM users u
         JOIN tenants t ON t.tenant_id = u.tenant_id
         WHERE u.tenant_id = $1 AND u.username = $2`,
        [tenant_id, username],
        tenant_id
    );

    const user = userResult.rows[0];

    // Unified error message prevents user-enumeration attacks
    const authFailedResponse = () =>
        res.status(401).json({ error: 'Invalid credentials' });

    if (!user || !user.is_active) return authFailedResponse();

    // Brute-force protection: lock after 5 failed attempts for 15 minutes
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const remainingMs = new Date(user.locked_until) - new Date();
        const remainingMin = Math.ceil(remainingMs / 60000);
        return res.status(429).json({
            error: `Account locked due to too many failed attempts. Try again in ${remainingMin} minutes.`
        });
    }

    let authValid = false;
    if (password && user.password_hash) {
        authValid = await bcrypt.compare(password, user.password_hash);
    } else if (pin && user.pin_hash) {
        authValid = await bcrypt.compare(pin, user.pin_hash);
    }

    if (!authValid) {
        // Increment failed attempts; lock if threshold reached
        const newAttempts = (user.failed_attempts || 0) + 1;
        const lockUntil = newAttempts >= 5
            ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
            : null;

        await tenantQuery(
            `UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE user_id = $3 AND tenant_id = $4`,
            [newAttempts, lockUntil, user.user_id, tenant_id],
            tenant_id
        );

        return authFailedResponse();
    }

    // Successful auth: reset failure counters
    await tenantQuery(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [user.user_id, tenant_id],
        tenant_id
    );

    // Fetch active module flags for this tenant
    const modulesResult = await tenantQuery(
        `SELECT module_restaurant, module_pharmacy, module_gym, module_salon,
                module_hotel, module_wholesale, module_ai_analytics, module_multi_terminal
         FROM tenant_feature_flags WHERE tenant_id = $1`,
        [tenant_id],
        tenant_id
    );
    const modules = modulesResult.rows[0] || {};

    // Issue tokens
    const accessToken = issueAccessToken({
        tenant_id,
        user_id:  user.user_id,
        role:     user.role,
        custom_role_id: user.custom_role_id,
        modules:  Object.entries(modules)
            .filter(([, v]) => v === true)
            .map(([k]) => k.replace('module_', ''))
    });
    const refreshToken = await issueRefreshToken(user.user_id, tenant_id);

    // Set refresh token in httpOnly, Secure, SameSite=Strict cookie
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge:   30 * 24 * 60 * 60 * 1000   // 30 days in ms
    });

    await writeAuditLog({
        tenantId:   tenant_id,
        userId:     user.user_id,
        action:     'user.login',
        entityType: 'user',
        entityId:   user.user_id,
        ipAddress:  req.ip
    });

    return res.json({
        access_token:    accessToken,
        account_status:  user.account_status,
        role:            user.role,
        custom_role_id:  user.custom_role_id
    });
});

// =============================================================================
// POST /api/v1/auth/refresh
// =============================================================================
router.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
        return res.status(401).json({ error: 'No refresh token provided' });
    }

    // Look up refresh session in Redis
    const sessionData = await getRedisClient().get(`refresh:${refreshToken}`);
    if (!sessionData) {
        return res.status(401).json({ error: 'Refresh token expired or invalid' });
    }

    const session = JSON.parse(sessionData);

    // Fetch user and modules for the new access token
    const userResult = await tenantQuery(
        `SELECT u.user_id, u.role, u.custom_role_id, u.is_active, t.account_status
         FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id
         WHERE u.user_id = $1 AND u.tenant_id = $2`,
        [session.user_id, session.tenant_id],
        session.tenant_id
    );

    const user = userResult.rows[0];
    if (!user || !user.is_active) {
        await getRedisClient().del(`refresh:${refreshToken}`);
        return res.status(401).json({ error: 'User account inactive' });
    }

    const modulesResult = await tenantQuery(
        `SELECT * FROM tenant_feature_flags WHERE tenant_id = $1`,
        [session.tenant_id],
        session.tenant_id
    );
    const modules = modulesResult.rows[0] || {};

    const accessToken = issueAccessToken({
        tenant_id: session.tenant_id,
        user_id:   user.user_id,
        role:      user.role,
        custom_role_id: user.custom_role_id,
        modules:   Object.entries(modules)
            .filter(([k, v]) => k.startsWith('module_') && v === true)
            .map(([k]) => k.replace('module_', ''))
    });

    return res.json({ access_token: accessToken });
});

// =============================================================================
// POST /api/v1/auth/logout
// =============================================================================
router.post('/logout', requireAuth, async (req, res) => {
    // Revoke access token JTI
    await revokeAccessToken(req.user);

    // Delete refresh token from Redis
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (refreshToken) {
        await getRedisClient().del(`refresh:${refreshToken}`);
    }

    res.clearCookie(REFRESH_TOKEN_COOKIE);

    await writeAuditLog({
        tenantId:   req.user.tenant_id,
        userId:     req.user.user_id,
        action:     'user.logout',
        entityType: 'user',
        entityId:   req.user.user_id,
        ipAddress:  req.ip
    });

    return res.json({ message: 'Logged out successfully' });
});

module.exports = router;
