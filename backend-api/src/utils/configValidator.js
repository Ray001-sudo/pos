'use strict';
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
module.exports = { validateConfig };