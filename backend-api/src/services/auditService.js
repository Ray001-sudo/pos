'use strict';

const { tenantQuery, adminQuery } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

// =============================================================================
// AUDIT LOG SERVICE
// Every write operation is recorded — hard deletes are forbidden
// =============================================================================

/**
 * Write an audit log entry.
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.userId
 * @param {string} params.action      - e.g. 'product.create', 'sale.void', 'user.login'
 * @param {string} params.entityType  - e.g. 'product', 'sale', 'user'
 * @param {string} params.entityId    - UUID of the affected entity
 * @param {object} params.oldValue    - Previous state (null for creates)
 * @param {object} params.newValue    - New state (null for deletes)
 * @param {string} params.ipAddress   - Caller IP address
 * @param {object} params.client      - Optional: existing DB client for transaction context
 * @param {boolean} params.isSuperadmin
 */
async function writeAuditLog({
    tenantId, userId, action, entityType, entityId,
    oldValue = null, newValue = null, ipAddress = null,
    client = null, isSuperadmin = false
}) {
    const logId = uuidv4();
    const sql = `
        INSERT INTO audit_logs
            (log_id, tenant_id, user_id, action, entity_type, entity_id, old_value, new_value, ip_address, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `;
    const params = [
        logId, tenantId, userId || null, action,
        entityType || null, entityId || null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        ipAddress
    ];

    if (client) {
        // Run within the caller's existing transaction
        await client.query(sql, params);
    } else {
        await tenantQuery(sql, params, tenantId, isSuperadmin);
    }
}

module.exports = { writeAuditLog };
