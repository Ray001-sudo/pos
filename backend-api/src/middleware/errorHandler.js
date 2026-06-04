'use strict';

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================
function redactPII(obj) {
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

function globalErrorHandler(logger) {
    return (err, req, res, next) => {
        const statusCode = err.statusCode || err.status || 500;
        const isProduction = process.env.NODE_ENV === 'production';

        logger.error({
            message: err.message,
            method: req.method,
            path: req.path,
            tenant_id: req.user?.tenant_id,
            statusCode,
            body: redactPII(req.body),
            headers: redactPII(req.headers)
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
                ip:        req.ip ? req.ip.replace(/\.\d+$/, '.0') : 'unknown'
            });
        });
        next();
    };
}

module.exports = { globalErrorHandler, requestLogger };
