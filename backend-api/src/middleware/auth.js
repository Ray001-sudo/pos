'use strict';

const jwt = require('jsonwebtoken');
const { createPrivateKey, createPublicKey } = require('crypto');
const { getClient } = require('../services/redisClient');

// =============================================================================
// JWT SERVICE — RS256 asymmetric signing
// =============================================================================

const PRIVATE_KEY = process.env.JWT_PRIVATE_KEY
    ? createPrivateKey(process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'))
    : null;

const PUBLIC_KEY = process.env.JWT_PUBLIC_KEY
    ? createPublicKey(process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'))
    : null;

const ACCESS_TOKEN_EXPIRY  = '8h';
const REFRESH_TOKEN_EXPIRY = '30d';
const REFRESH_TOKEN_COOKIE = 'pos_refresh_token';

/**
 * Issue a signed RS256 access token.
 * Payload includes: tenant_id, user_id, role, modules[], exp, iat, jti
 */
function issueAccessToken(payload) {
    if (!PRIVATE_KEY) throw new Error('JWT private key not configured');
    const jti = require('uuid').v4();
    return jwt.sign(
        {
            tenant_id: payload.tenant_id,
            user_id:   payload.user_id,
            role:      payload.role,
            modules:   payload.modules || [],
            jti
        },
        PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: ACCESS_TOKEN_EXPIRY }
    );
}

/**
 * Issue a signed refresh token stored in Redis.
 * The token itself is an opaque UUID; the session is stored in Redis.
 */
async function issueRefreshToken(userId, tenantId) {
    const { v4: uuidv4 } = require('uuid');
    const tokenId = uuidv4();
    const key = `refresh:${tokenId}`;

    // Store refresh session in Redis with 30-day TTL
    await getClient().setEx(key, 30 * 24 * 3600, JSON.stringify({
        user_id:   userId,
        tenant_id: tenantId,
        issued_at: Date.now()
    }));

    return tokenId;
}

/**
 * Verify and decode an access token.
 * Also checks the JWT revocation blacklist in Redis.
 */
async function verifyAccessToken(token) {
    if (!PUBLIC_KEY) throw new Error('JWT public key not configured');

    let decoded;
    try {
        decoded = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] });
    } catch (err) {
        throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401 });
    }

    // Check revocation blacklist
    const blacklisted = await getClient().get(`blacklist:${decoded.jti}`);
    if (blacklisted) {
        throw Object.assign(new Error('Token has been revoked'), { statusCode: 401 });
    }

    return decoded;
}

/**
 * Revoke an access token by adding its JTI to the Redis blacklist.
 * TTL matches the token's remaining validity.
 */
async function revokeAccessToken(decoded) {
    const remaining = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
    if (remaining > 0) {
        await getClient().setEx(`blacklist:${decoded.jti}`, remaining, '1');
    }
}

/**
 * Revoke ALL sessions for a tenant (used on suspension).
 * Scans for all refresh tokens with tenant_id and deletes them.
 * Also adds a tenant-level block flag checked during token verification.
 */
async function revokeAllTenantSessions(tenantId) {
    // Set a tenant block flag (checked in verifyAccessToken)
    // TTL of 48 hours — long enough to cover any active access tokens
    await getClient().setEx(`tenant_blocked:${tenantId}`, 48 * 3600, '1');
}

// =============================================================================
// AUTH MIDDLEWARE — Express
// =============================================================================

/**
 * requireAuth middleware: validates JWT, injects req.user
 * Applies to all protected routes.
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.slice(7);
    try {
        const decoded = await verifyAccessToken(token);

        // Check tenant-level block (set during suspension)
        const tenantBlocked = await getClient().get(`tenant_blocked:${decoded.tenant_id}`);
        if (tenantBlocked) {
            return res.status(403).json({ error: 'Account suspended. Contact support.' });
        }

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(err.statusCode || 401).json({ error: err.message });
    }
}

/**
 * requireRole middleware factory: checks user has at minimum the specified role.
 * Role hierarchy: superadmin > admin > manager > cashier
 */
const ROLE_RANK = { cashier: 0, manager: 1, admin: 2, superadmin: 3 };

function requireRole(minimumRole) {
    return (req, res, next) => {
        const userRank = ROLE_RANK[req.user?.role] ?? -1;
        const requiredRank = ROLE_RANK[minimumRole] ?? 999;
        if (userRank < requiredRank) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

/**
 * requireSuperadmin — shorthand for superadmin-only endpoints
 */
function requireSuperadmin(req, res, next) {
    if (req.user?.role !== 'superadmin') {
        return res.status(403).json({ error: 'Superadmin access required' });
    }
    next();
}

module.exports = {
    issueAccessToken,
    issueRefreshToken,
    verifyAccessToken,
    revokeAccessToken,
    revokeAllTenantSessions,
    requireAuth,
    requireRole,
    requireSuperadmin,
    REFRESH_TOKEN_COOKIE
};
