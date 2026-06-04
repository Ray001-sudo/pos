'use strict';

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { adminQuery } = require('../models/db');
const { revokeAllTenantSessions } = require('../middleware/auth');
const { logger } = require('../server');

// =============================================================================
// BILLING AUTOMATION JOB
// Runs daily at 00:05 UTC
// Implements the billing state machine:
//   active  →  past_due (if overdue 1-14 days)
//   past_due → suspended (if overdue 15+ days)
//   suspended → offline_timeout (if no handshake for 30 days post-suspension)
// =============================================================================

const GRACE_PERIOD_DAYS      = 14;   // Days before suspension
const OFFLINE_TIMEOUT_DAYS   = 30;   // Days after suspension before offline_timeout

async function runBillingJob() {
    logger.info('[BillingJob] Starting daily billing automation run');

    try {
        // -----------------------------------------------------------------------
        // STEP 1: Increment days_overdue for all non-cancelled tenants
        //         whose payment_due_date has passed
        // -----------------------------------------------------------------------
        await adminQuery(
            `UPDATE tenants
             SET days_overdue = (CURRENT_DATE - payment_due_date)
             WHERE payment_due_date IS NOT NULL
               AND CURRENT_DATE > payment_due_date
               AND account_status NOT IN ('cancelled', 'offline_timeout')`,
            []
        );
        logger.info('[BillingJob] Updated days_overdue for all overdue tenants');

        // -----------------------------------------------------------------------
        // STEP 2: Active → past_due (1 day overdue)
        // -----------------------------------------------------------------------
        const nowPastDue = await adminQuery(
            `UPDATE tenants
             SET account_status = 'past_due'
             WHERE account_status = 'active'
               AND days_overdue >= 1
             RETURNING tenant_id, business_name, days_overdue`,
            []
        );

        for (const t of nowPastDue.rows) {
            logger.warn(`[BillingJob] Tenant ${t.business_name} (${t.tenant_id}) moved to past_due (${t.days_overdue} days)`);
            await adminQuery(
                `INSERT INTO billing_events (event_id, tenant_id, event_type, notes)
                 VALUES ($1, $2, 'grace_period_started', $3)`,
                [uuidv4(), t.tenant_id, `${t.days_overdue} days overdue`]
            );
        }

        // -----------------------------------------------------------------------
        // STEP 3: past_due → suspended (>14 days overdue)
        // -----------------------------------------------------------------------
        const nowSuspended = await adminQuery(
            `UPDATE tenants
             SET account_status = 'suspended'
             WHERE account_status = 'past_due'
               AND days_overdue > ${GRACE_PERIOD_DAYS}
             RETURNING tenant_id, business_name, days_overdue`,
            []
        );

        for (const t of nowSuspended.rows) {
            logger.error(`[BillingJob] Tenant ${t.business_name} (${t.tenant_id}) SUSPENDED (${t.days_overdue} days overdue)`);

            // Immediately revoke all active sessions
            await revokeAllTenantSessions(t.tenant_id);

            await adminQuery(
                `INSERT INTO billing_events (event_id, tenant_id, event_type, notes)
                 VALUES ($1, $2, 'suspended', $3)`,
                [uuidv4(), t.tenant_id, `Auto-suspended after ${t.days_overdue} days overdue`]
            );
        }

        // -----------------------------------------------------------------------
        // STEP 4: suspended → offline_timeout
        //         (suspended for >30 days with no cloud handshake)
        // -----------------------------------------------------------------------
        const nowOfflineTimeout = await adminQuery(
            `UPDATE tenants
             SET account_status = 'offline_timeout'
             WHERE account_status = 'suspended'
               AND (
                   last_cloud_handshake IS NULL
                   OR last_cloud_handshake < NOW() - INTERVAL '${OFFLINE_TIMEOUT_DAYS} days'
               )
             RETURNING tenant_id, business_name, last_cloud_handshake`,
            []
        );

        for (const t of nowOfflineTimeout.rows) {
            logger.error(`[BillingJob] Tenant ${t.business_name} (${t.tenant_id}) moved to offline_timeout (no handshake since ${t.last_cloud_handshake})`);
        }

        logger.info(`[BillingJob] Run complete: ${nowPastDue.rows.length} past_due, ${nowSuspended.rows.length} suspended, ${nowOfflineTimeout.rows.length} offline_timeout`);
    } catch (err) {
        logger.error('[BillingJob] Error during billing run:', err);
    }
}

// Schedule: run daily at 00:05 UTC
const job = cron.schedule('5 0 * * *', runBillingJob, {
    scheduled: false,
    timezone: 'UTC'
});

module.exports = {
    start: () => {
        job.start();
        logger.info('[BillingJob] Scheduled for 00:05 UTC daily');
    },
    runNow: runBillingJob // exposed for manual triggers from admin panel
};
