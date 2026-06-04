'use strict';
require('express-async-errors');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const redisService = require('./services/redisClient');
const winston = require('winston');

const { pool, testConnection } = require('./models/db');
const authRoutes = require('./routes/auth');
const licenseRoutes = require('./routes/licenseRoute');
const syncRoutes = require('./routes/sync');
const productRoutes = require('./routes/products');
const salesRoutes = require('./routes/sales');
const restaurantRoutes = require('./routes/restaurant');
const membershipRoutes = require('./routes/memberships');
const appointmentRoutes = require('./routes/appointments');
const reportRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const inventoryRoutes = require('./routes/inventory');
const taxRoutes = require('./routes/tax');
const transactionsRoutes = require('./routes/transactions');
const crmRoutes = require('./routes/crm');
const shiftRoutes = require('./routes/shift');
const integrationsRoutes = require('./routes/integrations');
const { globalErrorHandler } = require('./middleware/errorHandler');
const { validateConfig } = require('./utils/configValidator');
validateConfig();
const { requestLogger } = require('./middleware/requestLogger');
const billingJob = require('./jobs/billingAutomation');

};
module.exports.logger = logger;

// =============================================================================
// EXPRESS APP
// =============================================================================
const app = express();

// Security headers — TLS enforcement happens at reverse-proxy (nginx) level
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
        }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// CORS: only allow the Admin Dashboard origin
app.use(cors({
    origin: process.env.ADMIN_DASHBOARD_ORIGIN || 'https://admin.yourdomain.com',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining']
}));

app.use(compression());
app.use(cookieParser());
app.use('/api/v1/sync', express.raw({ type: 'application/json', limit: '10mb' }));
app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/sync')) return next();
    express.json({ limit: '10mb' })(req, res, next);
});
app.use(requestLogger(logger));

// =============================================================================
// ROUTES
// =============================================================================
app.use('/api/v1/auth',         authRoutes);
app.use('/api/v1/license',      licenseRoutes);
app.use('/api/v1/sync',         syncRoutes);
app.use('/api/v1/products',     productRoutes);
app.use('/api/v1/sales',        salesRoutes);
app.use('/api/v1/restaurant',   restaurantRoutes);
app.use('/api/v1/memberships',  membershipRoutes);
app.use('/api/v1/appointments', appointmentRoutes);
app.use('/api/v1/reports',      reportRoutes);
app.use('/api/v1/admin',        adminRoutes);
app.use('/api/v1/inventory',    inventoryRoutes);
app.use('/api/v1/tax',          taxRoutes);
app.use('/api/v1/transactions', transactionsRoutes);
app.use('/api/v1/crm',          crmRoutes);
app.use('/api/v1/shift',        shiftRoutes);
app.use('/api/v1/integrations', integrationsRoutes);

// Health check endpoint
app.get('/health', async (req, res) => {
    const dbOk = await testConnection().catch(() => false);
    const redisOk = redisService.isReady();
    const status = dbOk && redisOk ? 200 : 503;
    res.status(status).json({ db: dbOk, redis: redisOk, uptime: process.uptime() });
});

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use(globalErrorHandler(logger));

// =============================================================================
// STARTUP
// =============================================================================
async function start() {
    try {
        await redisService.connect();
        await testConnection();
        logger.info('Database connection verified');

        // Start billing automation cron job
        billingJob.start();
        logger.info('Billing automation job started');

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => logger.info(`POS API server listening on port ${PORT}`));
    } catch (err) {
        logger.error('Startup failed:', err);
        process.exit(1);
    }
}

start();
