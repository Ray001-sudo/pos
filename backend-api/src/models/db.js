'use strict';

const { Pool } = require('pg');

// =============================================================================
// PostgreSQL Connection Pool
// =============================================================================
const pool = new Pool({
    host:               process.env.PG_HOST,
    port:               parseInt(process.env.PG_PORT || '5432'),
    database:           process.env.PG_DATABASE,
    user:               process.env.PG_USER,
    password:           process.env.PG_PASSWORD,
    max:                parseInt(process.env.PG_POOL_MAX || '20'),
    idleTimeoutMillis:  30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true, ca: process.env.PG_SSL_CA }
        : false
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Execute a query with automatic tenant context injection.
 * EVERY query that touches tenant data MUST pass tenantId.
 * This sets PostgreSQL session-level variables used by RLS policies.
 *
 * @param {string} text - Parameterized SQL query
 * @param {Array}  params - Query parameters
 * @param {string} tenantId - UUID of the authenticated tenant
 * @param {boolean} isSuperadmin - Whether caller has superadmin role
 */
async function tenantQuery(text, params, tenantId, isSuperadmin = false) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Inject tenant context for Row-Level Security
        await client.query(
            'SELECT set_tenant_context($1, $2)',
            [tenantId, isSuperadmin]
        );
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Execute multiple queries in a single transaction with tenant context.
 * @param {Function} callback - Async function receiving the client
 * @param {string} tenantId
 * @param {boolean} isSuperadmin
 */
async function tenantTransaction(callback, tenantId, isSuperadmin = false) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT set_tenant_context($1, $2)', [tenantId, isSuperadmin]);
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Superadmin-only query — no tenant context required.
 */
async function adminQuery(text, params) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.is_superadmin', 'true', true)");
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function testConnection() {
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
        return true;
    } finally {
        client.release();
    }
}

module.exports = { pool, tenantQuery, tenantTransaction, adminQuery, testConnection };
