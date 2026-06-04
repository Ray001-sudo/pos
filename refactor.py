import os
import re

BASE_DIR = "c:/Users/dedll/Desktop/pos-platform/pos-platform/pos/backend-api/src"

def create_redis_service():
    os.makedirs(os.path.join(BASE_DIR, "services"), exist_ok=True)
    file_path = os.path.join(BASE_DIR, "services/redisClient.js")
    code = """'use strict';
const { createClient } = require('redis');
const winston = require('winston');

// Ensure we don't have circular dependencies to server.js by using a basic fallback logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()]
});

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 5000) }
});

redisClient.on('error', (err) => logger.error('Redis error:', err));
redisClient.on('connect', () => logger.info('Redis connected'));

async function connect() {
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
}

function getClient() {
    if (!redisClient.isReady) {
        logger.error('Attempted to use Redis before connection is ready');
        throw new Error('Redis not connected');
    }
    return redisClient;
}

module.exports = {
    redisClient,
    connect,
    getClient,
    isReady: () => redisClient.isReady
};"""
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(code)

def patch_server_js():
    file_path = os.path.join(BASE_DIR, "server.js")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Replace Redis init with import
    redis_init = """const { createClient } = require('redis');"""
    redis_service_import = """const redisService = require('./services/redisClient');"""
    content = content.replace(redis_init, redis_service_import)

    redis_block_regex = r"// ===+[\s\S]*?REDIS CLIENT[\s\S]*?redisClient;[\s]*\n"
    content = re.sub(redis_block_regex, "", content)
    
    # Also remove module.exports.getRedisClient block if it exists
    get_redis_regex = r"module\.exports\.getRedisClient = \(\) => \{[\s\S]*?\};\n"
    content = re.sub(get_redis_regex, "", content)

    # Replace await redisClient.connect() with redisService.connect()
    content = content.replace("await redisClient.connect();", "await redisService.connect();")
    # Replace redisClient.isReady with redisService.isReady()
    content = content.replace("redisClient.isReady", "redisService.isReady()")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

def patch_callers_of_redis():
    files_to_patch = [
        "middleware/auth.js",
        "middleware/rateLimiter.js",
        "routes/auth.js"
    ]
    for rel_path in files_to_patch:
        file_path = os.path.join(BASE_DIR, rel_path)
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Replace requires
        content = content.replace("const { getRedisClient } = require('../server');", "const { getClient } = require('../services/redisClient');")
        content = content.replace("const { redisClient } = require('../server');", "const { getClient } = require('../services/redisClient');")
        
        # Replace usages
        content = content.replace("getRedisClient()", "getClient()")
        content = content.replace("redisClient.", "getClient().")
        
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

def create_hmac_middleware():
    os.makedirs(os.path.join(BASE_DIR, "middleware"), exist_ok=True)
    file_path = os.path.join(BASE_DIR, "middleware/hmac.js")
    code = """'use strict';
const crypto = require('crypto');

function verifyHmacSignature(req, res, next) {
    const signature = req.headers['x-signature'];
    const timestamp = req.headers['x-timestamp'];

    if (!signature || !timestamp) {
        return res.status(400).json({ error: 'Missing X-Signature or X-Timestamp header' });
    }

    // Sliding window: 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 300) {
        return res.status(401).json({ error: 'Request expired or invalid timestamp' });
    }

    const secret = process.env.HANDSHAKE_HMAC_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server misconfiguration' });

    if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'Raw body required for HMAC verification' });
    }

    // HMAC calculation includes timestamp
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
}

module.exports = { verifyHmacSignature };"""
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(code)

def patch_error_handler_hmac():
    file_path = os.path.join(BASE_DIR, "middleware/errorHandler.js")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Remove verifyHmacSignature completely
    hmac_regex = r"// =============================================================================\n// HMAC REQUEST SIGNATURE VERIFIER[\s\S]*?\}\n"
    content = re.sub(hmac_regex, "", content)
    content = content.replace(", verifyHmacSignature }", " }")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

def patch_license_js():
    file_path = os.path.join(BASE_DIR, "routes/license.js")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Fix broken imports
    content = content.replace("const { syncLimiter, verifyHmacSignature } = require('../middleware/rateLimiter');", "const { syncLimiter } = require('../middleware/rateLimiter');\nconst { verifyHmacSignature } = require('../middleware/hmac');")
    
    # Another wrong import might exist (the one we had before)
    content = content.replace("const { verifyHmacSignature: verifyHmac } = require('../middleware/errorHandler');", "const { verifyHmacSignature: verifyHmac } = require('../middleware/hmac');")

    # Apply verifyHmac to endpoints
    content = content.replace("syncRouter.post('/heartbeat', requireAuth, async (req, res) => {", "syncRouter.post('/heartbeat', requireAuth, verifyHmac, async (req, res) => {")
    content = content.replace("syncRouter.post('/transactions', requireAuth, async (req, res) => {", "syncRouter.post('/transactions', requireAuth, verifyHmac, async (req, res) => {")

    # Transaction Batch Refactoring: Replace SELECT FOR UPDATE + UPDATE with Atomic UPDATE RETURNING
    # And handle INSUFFICIENT_STOCK correctly
    atomic_update = """const stockRes = await client.query(
                        `UPDATE products SET stock_quantity = stock_quantity - $1 
                         WHERE product_id = $2 AND tenant_id = $3 AND stock_quantity >= $1 
                         RETURNING stock_quantity`,
                        [item.quantity, item.product_id, tenant_id]
                    );
                    
                    if (stockRes.rowCount === 0) {
                        throw new Error('INSUFFICIENT_STOCK');
                    }"""
    
    old_update = """const stockRes = await client.query(
                        `SELECT stock_quantity FROM products WHERE product_id = $1 AND tenant_id = $2 FOR UPDATE`,
                        [item.product_id, tenant_id]
                    );
                    
                    if (stockRes.rowCount === 0 || stockRes.rows[0].stock_quantity < item.quantity) {
                        throw new Error('INSUFFICIENT_STOCK');
                    }

                    await client.query(
                        `UPDATE products SET stock_quantity = stock_quantity - $1 WHERE product_id = $2 AND tenant_id = $3`,
                        [item.quantity, item.product_id, tenant_id]
                    );"""
    
    content = content.replace(old_update, atomic_update)

    # Change catch block to not return 400
    new_catch = """} catch (err) {
            rejected.push({ receipt_id: tx.receipt_id, reason: err.message });
        }"""
    old_catch = """} catch (err) {
            if (err.message === 'INSUFFICIENT_STOCK') {
                return res.status(400).json({ error: 'Insufficient stock for transaction' });
            }
            rejected.push({ receipt_id: tx.receipt_id, reason: err.message });
        }"""
    
    content = content.replace(old_catch, new_catch)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

print("Applying Refactor Patches...")
create_redis_service()
patch_server_js()
patch_callers_of_redis()
create_hmac_middleware()
patch_error_handler_hmac()
patch_license_js()
print("Refactoring Complete.")
