'use strict';

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================
function globalErrorHandler(logger) {
    return (err, req, res, next) => {
        const statusCode = err.statusCode || err.status || 500;
        const isProduction = process.env.NODE_ENV === 'production';

        logger.error({
            message: err.message,
            stack: err.stack,
            method: req.method,
            path: req.path,
            tenant_id: req.user?.tenant_id,
            statusCode
        });

        // Never leak stack traces in production
        res.status(statusCode).json({
            error: isProduction && statusCode >= 500
                ? 'An internal server error occurred'
                : err.message,
            ...(isProduction ? {} : { stack: err.stack })
        });
    };
}

// =============================================================================
// REQUEST LOGGER
// =============================================================================
function requestLogger(logger) {
    return (req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            logger.info({
                method:    req.method,
                path:      req.path,
                status:    res.statusCode,
                duration:  `${Date.now() - start}ms`,
                tenant_id: req.user?.tenant_id || 'unauthenticated',
                ip:        req.ip
            });
        });
        next();
    };
}

// =============================================================================
// HMAC REQUEST SIGNATURE VERIFIER
// Used on sync endpoints to verify C++ client payload integrity
// =============================================================================
const crypto = require('crypto');

function verifyHmacSignature(req, res, next) {
    const signature = req.headers['x-signature'];
    if (!signature) {
        return res.status(400).json({ error: 'Missing X-Signature header' });
    }

    const secret = process.env.SYNC_HMAC_SECRET;
    if (!secret) {
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const body = JSON.stringify(req.body);
    const expected = crypto
        .createHmac('sha256', secret)
        .update(body, 'utf8')
        .digest('hex');

    // Constant-time comparison prevents timing attacks
    const signatureBuffer  = Buffer.from(signature, 'hex');
    const expectedBuffer   = Buffer.from(expected,   'hex');

    if (signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return res.status(401).json({ error: 'Invalid request signature' });
    }

    next();
}

module.exports = { globalErrorHandler, requestLogger, verifyHmacSignature };
