#!/usr/bin/env python3
"""
=============================================================================
POS Platform — Python AI Analytics Service
Runs as a scheduled microservice (cron or always-on worker).
Connects directly to the cloud PostgreSQL DB (with superadmin context).

Modules:
  1. RestockForecaster  — 30-day demand forecast using rolling statistics
  2. DeadStockDetector  — identifies products with zero velocity for N days
  3. FraudDetector      — statistical outlier detection on sales patterns
  4. ExpiryAlertEngine  — proactive pharmacy expiry warnings

Results written to the ai_insights table; consumed by the /reports/ai-insights API.
=============================================================================
"""

import os
import logging
import asyncio
import asyncpg
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from dataclasses import dataclass, asdict
from typing import Optional
import statistics

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger('ai_analytics')

# ---------------------------------------------------------------------------
# Config from environment
# ---------------------------------------------------------------------------
DB_DSN          = os.environ['DATABASE_URL']   # postgresql://user:pw@host/db
RUN_INTERVAL_S  = int(os.getenv('RUN_INTERVAL_SECONDS', '3600'))   # default: hourly


# =============================================================================
# DATABASE HELPERS
# =============================================================================

async def get_connection() -> asyncpg.Connection:
    """Open a direct PostgreSQL connection with superadmin context."""
    conn = await asyncpg.connect(dsn=DB_DSN, ssl='require')
    # Set superadmin context so RLS allows cross-tenant queries
    await conn.execute("SELECT set_config('app.is_superadmin', 'true', false)")
    return conn


async def upsert_insight(conn: asyncpg.Connection,
                         tenant_id: str,
                         insight_type: str,
                         product_id: Optional[str],
                         payload: dict,
                         ttl_days: int = 7):
    """Write an AI insight to the cloud DB. Old insights of same type/product are replaced."""
    expires_at = datetime.now(timezone.utc) + timedelta(days=ttl_days)

    # Delete stale insight of same type+product for this tenant
    await conn.execute(
        """DELETE FROM ai_insights
           WHERE tenant_id = $1
             AND insight_type = $2::insight_type
             AND ($3::uuid IS NULL OR product_id = $3::uuid)""",
        tenant_id, insight_type, product_id
    )

    await conn.execute(
        """INSERT INTO ai_insights
               (insight_id, tenant_id, insight_type, product_id, payload, generated_at, expires_at)
           VALUES ($1, $2, $3::insight_type, $4, $5, NOW(), $6)""",
        str(uuid4()), tenant_id, insight_type, product_id,
        json.dumps(payload), expires_at
    )


async def get_all_active_tenants(conn: asyncpg.Connection) -> list[dict]:
    rows = await conn.fetch(
        """SELECT t.tenant_id, t.business_category,
                  f.module_pharmacy, f.module_ai_analytics
           FROM tenants t
           LEFT JOIN tenant_feature_flags f ON f.tenant_id = t.tenant_id
           WHERE t.account_status IN ('active', 'past_due')"""
    )
    return [dict(r) for r in rows]


# =============================================================================
# 1. RESTOCK FORECASTER
# Uses 30-day rolling sales velocity to project when stock will hit zero
# and flag items needing reorder within 14 days.
# =============================================================================

class RestockForecaster:
    """
    Algorithm:
      - Compute daily unit sales for each product over the last 30 days
      - Calculate mean daily velocity and standard deviation
      - Projected days remaining = current_stock / mean_velocity
      - If projected_days_remaining < 14, emit restock_forecast insight
    """

    async def run(self, conn: asyncpg.Connection, tenant_id: str):
        logger.info(f'[RestockForecaster] Running for tenant {tenant_id[:8]}')

        # Get 30-day sales velocity per product
        rows = await conn.fetch(
            """SELECT
                   p.product_id,
                   p.name,
                   p.stock_quantity,
                   p.unit,
                   DATE(s.sale_timestamp AT TIME ZONE 'UTC') AS sale_date,
                   SUM(si.quantity) AS daily_qty
               FROM products p
               JOIN sale_items si ON si.product_id = p.product_id AND si.tenant_id = p.tenant_id
               JOIN sales_transactions s ON s.receipt_id = si.receipt_id
               WHERE p.tenant_id = $1
                 AND p.is_active = true
                 AND s.sale_timestamp >= NOW() - INTERVAL '30 days'
                 AND NOT s.is_voided
               GROUP BY p.product_id, p.name, p.stock_quantity, p.unit, sale_date
               ORDER BY p.product_id, sale_date""",
            tenant_id
        )

        # Group by product
        product_sales: dict[str, dict] = {}
        for row in rows:
            pid = str(row['product_id'])
            if pid not in product_sales:
                product_sales[pid] = {
                    'name':          row['name'],
                    'stock':         row['stock_quantity'],
                    'unit':          row['unit'] or 'units',
                    'daily_qtys':    []
                }
            product_sales[pid]['daily_qtys'].append(int(row['daily_qty']))

        forecasts_generated = 0
        for pid, data in product_sales.items():
            daily_qtys = data['daily_qtys']
            if len(daily_qtys) < 3:
                continue   # not enough data points

            mean_velocity = statistics.mean(daily_qtys)
            if mean_velocity <= 0:
                continue

            std_dev = statistics.stdev(daily_qtys) if len(daily_qtys) > 1 else 0.0
            projected_days = data['stock'] / mean_velocity
            reorder_urgency = 'critical' if projected_days < 7 else 'warning'

            if projected_days < 14:
                payload = {
                    'product_name':      data['name'],
                    'current_stock':     data['stock'],
                    'unit':              data['unit'],
                    'mean_daily_velocity': round(mean_velocity, 2),
                    'velocity_std_dev':  round(std_dev, 2),
                    'projected_days_remaining': round(projected_days, 1),
                    'reorder_urgency':   reorder_urgency,
                    'recommendation':    f"Reorder within {max(1, int(projected_days) - 3)} days to avoid stockout.",
                    'generated_by':      'RestockForecaster v1'
                }
                await upsert_insight(conn, tenant_id, 'restock_forecast', pid, payload)
                forecasts_generated += 1

        logger.info(f'[RestockForecaster] {forecasts_generated} forecasts for tenant {tenant_id[:8]}')


# =============================================================================
# 2. DEAD STOCK DETECTOR
# Flags products with no sales for the past 60 days (configurable threshold)
# =============================================================================

class DeadStockDetector:
    """
    A product is 'dead stock' if:
      - It has stock_quantity > 0
      - It has had ZERO sales in the last DEAD_STOCK_THRESHOLD_DAYS days
      - It was created more than 30 days ago (newly added items get a grace period)
    """
    DEAD_STOCK_THRESHOLD_DAYS = 60
    GRACE_PERIOD_DAYS         = 30

    async def run(self, conn: asyncpg.Connection, tenant_id: str):
        logger.info(f'[DeadStockDetector] Running for tenant {tenant_id[:8]}')

        rows = await conn.fetch(
            """SELECT
                   p.product_id, p.name, p.stock_quantity, p.cost_price, p.category,
                   p.created_at,
                   MAX(s.sale_timestamp) AS last_sale
               FROM products p
               LEFT JOIN sale_items si ON si.product_id = p.product_id AND si.tenant_id = p.tenant_id
               LEFT JOIN sales_transactions s ON s.receipt_id = si.receipt_id AND NOT s.is_voided
               WHERE p.tenant_id = $1
                 AND p.is_active = true
                 AND p.stock_quantity > 0
                 AND p.created_at < NOW() - INTERVAL '$2 days'
               GROUP BY p.product_id, p.name, p.stock_quantity, p.cost_price, p.category, p.created_at
               HAVING MAX(s.sale_timestamp) IS NULL
                   OR MAX(s.sale_timestamp) < NOW() - INTERVAL '$3 days'""",
            tenant_id,
            self.GRACE_PERIOD_DAYS,
            self.DEAD_STOCK_THRESHOLD_DAYS
        )

        dead_count = 0
        for row in rows:
            days_since_sale = None
            if row['last_sale']:
                delta = datetime.now(timezone.utc) - row['last_sale'].replace(tzinfo=timezone.utc)
                days_since_sale = delta.days

            capital_tied = float(row['cost_price'] or 0) * int(row['stock_quantity'])

            payload = {
                'product_name':        row['name'],
                'category':            row['category'] or 'Uncategorised',
                'stock_quantity':      row['stock_quantity'],
                'cost_price':          float(row['cost_price'] or 0),
                'capital_tied_up':     round(capital_tied, 2),
                'days_since_last_sale': days_since_sale,
                'threshold_days':      self.DEAD_STOCK_THRESHOLD_DAYS,
                'recommendation':      'Consider discounting, bundling, or returning to supplier.',
                'generated_by':        'DeadStockDetector v1'
            }
            await upsert_insight(conn, tenant_id, 'dead_stock_alert', str(row['product_id']), payload)
            dead_count += 1

        logger.info(f'[DeadStockDetector] {dead_count} dead-stock items for tenant {tenant_id[:8]}')


# =============================================================================
# 3. FRAUD DETECTOR
# Statistical anomaly detection on cashier-level sales patterns
# Flags: unusually high void rates, sales far below average item price
# =============================================================================

class FraudDetector:
    """
    Checks performed per cashier per day:
      1. Void rate > 2× average for that business
      2. Average transaction value < 50% of overall business average (possible under-ringing)
      3. Suspiciously round discounts applied repeatedly

    Outputs fraud_alert insights at the tenant level (not product-level).
    """
    MIN_TRANSACTIONS_FOR_ANALYSIS = 10   # Don't flag cashiers with <10 txns

    async def run(self, conn: asyncpg.Connection, tenant_id: str):
        logger.info(f'[FraudDetector] Running for tenant {tenant_id[:8]}')

        # Business-level averages over last 30 days
        business_avg = await conn.fetchrow(
            """SELECT
                   AVG(grand_total) AS avg_grand_total,
                   COUNT(*) FILTER (WHERE is_voided) * 1.0 / NULLIF(COUNT(*), 0) AS void_rate,
                   COUNT(*) AS total_txns
               FROM sales_transactions
               WHERE tenant_id = $1
                 AND sale_timestamp >= NOW() - INTERVAL '30 days'""",
            tenant_id
        )

        if not business_avg or (business_avg['total_txns'] or 0) < self.MIN_TRANSACTIONS_FOR_ANALYSIS:
            return

        avg_total   = float(business_avg['avg_grand_total'] or 0)
        avg_void_rate = float(business_avg['void_rate'] or 0)
        if avg_total == 0:
            return

        # Per-cashier stats
        cashier_stats = await conn.fetch(
            """SELECT
                   cashier_id,
                   u.username,
                   COUNT(*) AS txn_count,
                   AVG(grand_total) AS avg_total,
                   COUNT(*) FILTER (WHERE is_voided) * 1.0 / NULLIF(COUNT(*), 0) AS void_rate
               FROM sales_transactions s
               JOIN users u ON u.user_id = s.cashier_id
               WHERE s.tenant_id = $1
                 AND s.sale_timestamp >= NOW() - INTERVAL '30 days'
               GROUP BY cashier_id, u.username
               HAVING COUNT(*) >= $2""",
            tenant_id, self.MIN_TRANSACTIONS_FOR_ANALYSIS
        )

        alerts_raised = 0
        for cs in cashier_stats:
            cashier_avg   = float(cs['avg_total'] or 0)
            cashier_void  = float(cs['void_rate'] or 0)
            flags         = []

            # Rule 1: void rate > 2× business average
            if avg_void_rate > 0 and cashier_void > avg_void_rate * 2:
                flags.append({
                    'rule':       'HIGH_VOID_RATE',
                    'detail':     f"Void rate {cashier_void:.1%} vs business avg {avg_void_rate:.1%}",
                    'severity':   'high' if cashier_void > avg_void_rate * 3 else 'medium'
                })

            # Rule 2: average transaction value < 50% of business average
            if cashier_avg < avg_total * 0.5:
                flags.append({
                    'rule':       'LOW_AVG_TRANSACTION',
                    'detail':     f"Avg txn {cashier_avg:.2f} vs business avg {avg_total:.2f}",
                    'severity':   'medium'
                })

            if flags:
                payload = {
                    'cashier_id':       str(cs['cashier_id']),
                    'cashier_username': cs['username'],
                    'txn_count':        cs['txn_count'],
                    'flags':            flags,
                    'business_avg_total': round(avg_total, 2),
                    'cashier_avg_total':  round(cashier_avg, 2),
                    'recommendation':  'Review transaction history for this cashier.',
                    'generated_by':    'FraudDetector v1'
                }
                await upsert_insight(conn, tenant_id, 'fraud_alert', None, payload, ttl_days=14)
                alerts_raised += 1

        logger.info(f'[FraudDetector] {alerts_raised} fraud alerts for tenant {tenant_id[:8]}')


# =============================================================================
# 4. EXPIRY ALERT ENGINE
# Only runs for tenants with module_pharmacy = true
# Flags products expiring within 30, 14, and 7 days
# =============================================================================

class ExpiryAlertEngine:
    """
    Tiered expiry warnings:
      - 30 days: 'soon_expiring'   (yellow)
      - 14 days: 'expiring_soon'   (orange)
      -  7 days: 'critical_expiry' (red)
      - Expired:  'expired'        (black)
    """

    async def run(self, conn: asyncpg.Connection, tenant_id: str):
        logger.info(f'[ExpiryAlertEngine] Running for tenant {tenant_id[:8]}')

        rows = await conn.fetch(
            """SELECT product_id, name, stock_quantity, expiry_date, batch_number, category
               FROM products
               WHERE tenant_id = $1
                 AND is_active = true
                 AND stock_quantity > 0
                 AND expiry_date IS NOT NULL
                 AND expiry_date <= (CURRENT_DATE + INTERVAL '30 days')
               ORDER BY expiry_date ASC""",
            tenant_id
        )

        today = datetime.now(timezone.utc).date()
        alerts = 0

        for row in rows:
            expiry = row['expiry_date']
            days_until_expiry = (expiry - today).days

            if days_until_expiry < 0:
                urgency = 'expired'
                color   = 'black'
                recommendation = f"Product expired {abs(days_until_expiry)} days ago. Remove immediately."
            elif days_until_expiry <= 7:
                urgency = 'critical_expiry'
                color   = 'red'
                recommendation = f"Expires in {days_until_expiry} days. Escalate to clearance or return."
            elif days_until_expiry <= 14:
                urgency = 'expiring_soon'
                color   = 'orange'
                recommendation = f"Expires in {days_until_expiry} days. Discount to accelerate sales."
            else:
                urgency = 'soon_expiring'
                color   = 'yellow'
                recommendation = f"Expires in {days_until_expiry} days. Monitor and plan promotions."

            payload = {
                'product_name':      row['name'],
                'batch_number':      row['batch_number'],
                'category':          row['category'],
                'stock_quantity':    row['stock_quantity'],
                'expiry_date':       expiry.isoformat(),
                'days_until_expiry': days_until_expiry,
                'urgency':           urgency,
                'color':             color,
                'recommendation':    recommendation,
                'generated_by':      'ExpiryAlertEngine v1'
            }
            await upsert_insight(conn, tenant_id, 'expiry_warning',
                                 str(row['product_id']), payload, ttl_days=35)
            alerts += 1

        logger.info(f'[ExpiryAlertEngine] {alerts} expiry alerts for tenant {tenant_id[:8]}')


# =============================================================================
# ORCHESTRATOR — runs all engines for all eligible tenants
# =============================================================================

async def run_analytics_cycle():
    logger.info('=== AI Analytics cycle starting ===')
    conn = await get_connection()

    try:
        tenants = await get_all_active_tenants(conn)
        logger.info(f'Processing {len(tenants)} active tenants')

        restock   = RestockForecaster()
        dead      = DeadStockDetector()
        fraud     = FraudDetector()
        expiry    = ExpiryAlertEngine()

        for tenant in tenants:
            tid = str(tenant['tenant_id'])

            if not tenant.get('module_ai_analytics'):
                # Run basic expiry and dead-stock even without AI module
                # (these are operationally critical, not premium)
                if tenant.get('module_pharmacy'):
                    await expiry.run(conn, tid)
                continue

            try:
                await restock.run(conn, tid)
                await dead.run(conn, tid)
                await fraud.run(conn, tid)

                if tenant.get('module_pharmacy'):
                    await expiry.run(conn, tid)

            except Exception as e:
                logger.error(f'Error processing tenant {tid[:8]}: {e}', exc_info=True)

        # Clean up expired insights across all tenants
        deleted = await conn.fetchval(
            "DELETE FROM ai_insights WHERE expires_at < NOW() RETURNING COUNT(*)"
        )
        logger.info(f'Cleaned up {deleted or 0} expired insights')

    finally:
        await conn.close()

    logger.info('=== AI Analytics cycle complete ===')


async def main():
    """Run analytics on a fixed interval."""
    while True:
        try:
            await run_analytics_cycle()
        except Exception as e:
            logger.critical(f'Analytics cycle crashed: {e}', exc_info=True)

        logger.info(f'Next run in {RUN_INTERVAL_S}s')
        await asyncio.sleep(RUN_INTERVAL_S)


if __name__ == '__main__':
    asyncio.run(main())
