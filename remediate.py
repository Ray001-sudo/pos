import os
import re

BASE_DIR = "c:/Users/dedll/Desktop/pos-platform/pos-platform/pos/backend-api/src"

def patch_server_js():
    file_path = os.path.join(BASE_DIR, "server.js")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Config validator
    if "configValidator" not in content:
        imports = "const { globalErrorHandler } = require('./middleware/errorHandler');\nconst { validateConfig } = require('./utils/configValidator');\nvalidateConfig();"
        content = content.replace("const { globalErrorHandler } = require('./middleware/errorHandler');", imports)

    # 2. Redis export
    redis_export = """module.exports.getRedisClient = () => {
    if (!redisClient.isReady) {
        logger.error('Attempted to use Redis before connection is ready');
        throw new Error('Redis not connected');
    }
    return redisClient;
};"""
    content = content.replace("module.exports.redisClient = redisClient;", redis_export)

    # 3. Raw body for sync
    raw_body_setup = """app.use('/api/v1/sync', express.raw({ type: 'application/json', limit: '10mb' }));
app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/sync')) return next();
    express.json({ limit: '10mb' })(req, res, next);
});"""
    content = content.replace("app.use(express.json({ limit: '10mb' }));", raw_body_setup)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

def patch_error_handler():
    file_path = os.path.join(BASE_DIR, "middleware/errorHandler.js")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Redaction logic
    redact_func = """function redactPII(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Buffer.isBuffer(obj)) return '[BUFFER]';
    const redacted = Array.isArray(obj) ? [] : {};
    const sensitiveKeys = ['password', 'password_hash', 'pin', 'pin_hash', 'email', 'phone', 'authorization', 'x-signature'];
    for (const key of Object.keys(obj)) {
        if (sensitiveKeys.includes(key.toLowerCase())) {
            redacted[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
            redacted[key] = redactPII(obj[key]);
        } else {
            redacted[key] = obj[key];
        }
    }
    return redacted;
}

function globalErrorHandler"""
    content = content.replace("function globalErrorHandler", redact_func)

    error_log = """logger.error({
            message: err.message,
            method: req.method,
            path: req.path,
            tenant_id: req.user?.tenant_id,
            statusCode,
            body: redactPII(req.body),
            headers: redactPII(req.headers)
        });"""
    content = re.sub(r"logger\.error\(\{[\s\S]*?\}\);", error_log, content, count=1)

    # HMAC raw buffer
    hmac_raw = """function verifyHmacSignature(req, res, next) {
    const signature = req.headers['x-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing X-Signature header' });
    const secret = process.env.SYNC_HMAC_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server misconfiguration' });

    if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'Raw body required for HMAC verification' });
    }

    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return res.status(401).json({ error: 'Invalid request signature' });
    }

    try {
        req.body = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    next();
}"""
    content = re.sub(r"function verifyHmacSignature[\s\S]*?next\(\);\n\}", hmac_raw, content)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

def patch_license():
    file_path = os.path.join(BASE_DIR, "routes/license.js")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Uniqueness & Atomicity
    atomicity = """const txRes = await client.query(
                    `INSERT INTO sales_transactions
                        (receipt_id, tenant_id, terminal_id, cashier_id, subtotal, tax_total,
                         discount_total, grand_total, payment_method, sale_timestamp, is_voided, void_reason)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     ON CONFLICT (receipt_id) DO NOTHING RETURNING receipt_id`,
                    [
                        tx.receipt_id, tenant_id, tx.terminal_id, tx.cashier_id,
                        tx.subtotal, tx.tax_total, tx.discount_total, tx.grand_total,
                        tx.payment_method, tx.sale_timestamp, tx.is_voided, tx.void_reason || null
                    ]
                );

                if (txRes.rowCount === 0) return; // duplicate/idempotent

                // Insert sale items
                for (const item of tx.items) {
                    await client.query(
                        `INSERT INTO sale_items (item_id, receipt_id, tenant_id, product_id, quantity, unit_price, line_total)
                         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
                        [uuidv4(), tx.receipt_id, tenant_id, item.product_id, item.quantity, item.unit_price, item.line_total]
                    );

                    const stockRes = await client.query(
                        `SELECT stock_quantity FROM products WHERE product_id = $1 AND tenant_id = $2 FOR UPDATE`,
                        [item.product_id, tenant_id]
                    );
                    
                    if (stockRes.rowCount === 0 || stockRes.rows[0].stock_quantity < item.quantity) {
                        throw new Error('INSUFFICIENT_STOCK');
                    }

                    await client.query(
                        `UPDATE products SET stock_quantity = stock_quantity - $1 WHERE product_id = $2 AND tenant_id = $3`,
                        [item.quantity, item.product_id, tenant_id]
                    );
                }"""
    
    orig_tx = """await client.query(
                    `INSERT INTO sales_transactions
                        (receipt_id, tenant_id, terminal_id, cashier_id, subtotal, tax_total,
                         discount_total, grand_total, payment_method, sale_timestamp, is_voided, void_reason)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     ON CONFLICT (receipt_id) DO NOTHING`,
                    [
                        tx.receipt_id, tenant_id, tx.terminal_id, tx.cashier_id,
                        tx.subtotal, tx.tax_total, tx.discount_total, tx.grand_total,
                        tx.payment_method, tx.sale_timestamp, tx.is_voided, tx.void_reason || null
                    ]
                );

                // Insert sale items
                for (const item of tx.items) {
                    await client.query(
                        `INSERT INTO sale_items (item_id, receipt_id, tenant_id, product_id, quantity, unit_price, line_total)
                         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
                        [uuidv4(), tx.receipt_id, tenant_id, item.product_id, item.quantity, item.unit_price, item.line_total]
                    );
                    // Decrement stock
                    await client.query(
                        `UPDATE products SET stock_quantity = GREATEST(0, stock_quantity - $1)
                         WHERE product_id = $2 AND tenant_id = $3`,
                        [item.quantity, item.product_id, tenant_id]
                    );
                }"""
    content = content.replace(orig_tx, atomicity)

    # Error handling for INSUFFICIENT_STOCK
    catch_block = """} catch (err) {
            if (err.message === 'INSUFFICIENT_STOCK') {
                return res.status(400).json({ error: 'Insufficient stock for transaction' });
            }
            rejected.push({ receipt_id: tx.receipt_id, reason: err.message });
        }"""
    content = content.replace("} catch (err) {\n            rejected.push({ receipt_id: tx.receipt_id, reason: err.message });\n        }", catch_block)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

def create_validator():
    os.makedirs(os.path.join(BASE_DIR, "utils"), exist_ok=True)
    file_path = os.path.join(BASE_DIR, "utils/configValidator.js")
    code = """'use strict';
function validateConfig() {
    const required = [
        'HANDSHAKE_HMAC_SECRET', 'SYNC_HMAC_SECRET',
        'PG_HOST', 'PG_USER', 'PG_PASSWORD', 'REDIS_URL', 'ADMIN_DASHBOARD_ORIGIN'
    ];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`CRITICAL ERROR: Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
}
module.exports = { validateConfig };"""
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(code)

def replace_redis_client_in_file(rel_path):
    file_path = os.path.join(BASE_DIR, rel_path)
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    
    content = content.replace("const { redisClient } = require('../server');", "const { getRedisClient } = require('../server');")
    content = content.replace("redisClient.", "getRedisClient().")
    
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

patch_server_js()
patch_error_handler()
patch_license()
create_validator()

replace_redis_client_in_file("middleware/auth.js")
replace_redis_client_in_file("middleware/rateLimiter.js")
replace_redis_client_in_file("routes/auth.js")

print("All remediations applied successfully.")
