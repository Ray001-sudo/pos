'use strict';
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

module.exports = { verifyHmacSignature };