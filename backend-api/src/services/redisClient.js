'use strict';
const { createClient } = require('redis');
const winston = require('winston');

// Ensure we don't have circular dependencies to server.js by using a basic fallback logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()]
});

const redisClient = createClient({
    url: process.env.REDIS_URL,
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
};