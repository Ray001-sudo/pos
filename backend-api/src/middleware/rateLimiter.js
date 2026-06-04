'use strict';

const { getClient } = require('../services/redisClient');

// =============================================================================
// RATE LIMITER — Redis Sliding Window
// 100 requests per minute per tenant (or per IP for unauthenticated routes)
// =============================================================================

/**
 * Creates a rate limiter middleware with Redis sliding window algorithm.
 * @param {object} options
 * @param {number} options.windowSeconds - Time window in seconds (default: 60)
 * @param {number} options.maxRequests   - Max requests in window (default: 100)
 * @param {string} options.keyPrefix     - Redis key prefix
 */
function createRateLimiter({ windowSeconds = 60, maxRequests = 100, keyPrefix = 'rl' } = {}) {
    return async (req, res, next) => {
        // Use tenant_id if authenticated, otherwise fall back to IP
        const identifier = req.user?.tenant_id || req.ip;
        const now = Date.now();
        const windowStart = now - windowSeconds * 1000;
        const key = `${keyPrefix}:${identifier}`;

        try {
            // Sliding window: remove entries older than the window, then add current timestamp
            const pipe = getClient().multi();
            pipe.zRemRangeByScore(key, '-inf', windowStart.toString());
            pipe.zAdd(key, [{ score: now, value: `${now}-${Math.random()}` }]);
            pipe.zCard(key);
            pipe.expire(key, windowSeconds * 2);
            const results = await pipe.exec();

            const requestCount = results[2]; // zCard result

            res.setHeader('X-RateLimit-Limit', maxRequests);
            res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - requestCount));
            res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowSeconds * 1000) / 1000));

            if (requestCount > maxRequests) {
                return res.status(429).json({
                    error: 'Rate limit exceeded. Please slow down your requests.',
                    retryAfter: windowSeconds
                });
            }

            next();
        } catch (err) {
            // On Redis failure, fail open (don't block legitimate traffic)
            console.error('Rate limiter Redis error:', err);
            next();
        }
    };
}

// Pre-configured limiters for different endpoint categories
const standardLimiter = createRateLimiter({ windowSeconds: 60, maxRequests: 100 });
const authLimiter     = createRateLimiter({ windowSeconds: 60, maxRequests: 10,  keyPrefix: 'rl:auth' });
const syncLimiter     = createRateLimiter({ windowSeconds: 60, maxRequests: 200, keyPrefix: 'rl:sync' });
const adminLimiter    = createRateLimiter({ windowSeconds: 60, maxRequests: 300, keyPrefix: 'rl:admin' });

module.exports = { createRateLimiter, standardLimiter, authLimiter, syncLimiter, adminLimiter };
