const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { z } = require('zod');

// Mock dependencies before requiring the router
jest.mock('../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        req.user = { tenant_id: 'tenant-123' };
        next();
    }
}));

jest.mock('../src/middleware/rateLimiter', () => ({
    syncLimiter: (req, res, next) => next()
}));

jest.mock('../src/middleware/hmac', () => ({
    verifyHmacSignature: (req, res, next) => next()
}));

// Mock DB interactions
const mockDbMocks = {
    tenantTransaction: jest.fn(),
    tenantQuery: jest.fn()
};
jest.mock('../src/models/db', () => mockDbMocks);
jest.mock('../src/services/auditService', () => ({ writeAuditLog: jest.fn() }));

const { syncRouter } = require('../src/routes/license');

const app = express();
app.use(express.json()); // For tests we can use standard json parsing to bypass the raw body requirement
app.use('/sync', syncRouter);

describe('POST /sync/transactions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should process a mixed batch and return accepted and rejected receipts', async () => {
        // We simulate tenantTransaction implementation
        mockDbMocks.tenantTransaction.mockImplementation(async (callback) => {
            const clientMock = {
                query: jest.fn().mockImplementation(async (sql, params) => {
                    if (sql.includes('INSERT INTO sales_transactions')) {
                        return { rowCount: 1 };
                    }
                    if (sql.includes('INSERT INTO sale_items')) {
                        return { rowCount: 1 };
                    }
                    if (sql.includes('UPDATE products SET stock_quantity')) {
                        // Product 2 fails stock atomicity check
                        if (params[1] === '22222222-2222-2222-2222-222222222222') {
                            return { rowCount: 0 }; // INSUFFICIENT_STOCK
                        }
                        return { rowCount: 1, rows: [{ stock_quantity: 5 }] };
                    }
                    return { rowCount: 1 };
                })
            };
            await callback(clientMock);
        });

        const payload = {
            transactions: [
                {
                    receipt_id: '11111111-1111-1111-1111-111111111111',
                    terminal_id: '11111111-1111-1111-1111-111111111111',
                    cashier_id: '11111111-1111-1111-1111-111111111111',
                    subtotal: 10, tax_total: 0, discount_total: 0, grand_total: 10,
                    payment_method: 'cash',
                    sale_timestamp: new Date().toISOString(),
                    is_voided: false,
                    items: [{ product_id: '11111111-1111-1111-1111-111111111111', quantity: 1, unit_price: 10, line_total: 10 }]
                },
                {
                    receipt_id: '22222222-2222-2222-2222-222222222222',
                    terminal_id: '11111111-1111-1111-1111-111111111111',
                    cashier_id: '11111111-1111-1111-1111-111111111111',
                    subtotal: 10, tax_total: 0, discount_total: 0, grand_total: 10,
                    payment_method: 'cash',
                    sale_timestamp: new Date().toISOString(),
                    is_voided: false,
                    items: [{ product_id: '22222222-2222-2222-2222-222222222222', quantity: 100, unit_price: 10, line_total: 1000 }]
                },
                {
                    receipt_id: '33333333-3333-3333-3333-333333333333',
                    terminal_id: '11111111-1111-1111-1111-111111111111',
                    cashier_id: '11111111-1111-1111-1111-111111111111',
                    subtotal: 10, tax_total: 0, discount_total: 0, grand_total: 10,
                    payment_method: 'cash',
                    sale_timestamp: new Date().toISOString(),
                    is_voided: false,
                    items: [{ product_id: '33333333-3333-3333-3333-333333333333', quantity: 1, unit_price: 10, line_total: 10 }]
                }
            ]
        };

        const res = await request(app)
            .post('/sync/transactions')
            .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.accepted.length).toBe(2);
        expect(res.body.accepted).toContain('11111111-1111-1111-1111-111111111111');
        expect(res.body.accepted).toContain('33333333-3333-3333-3333-333333333333');
        expect(res.body.rejected.length).toBe(1);
        expect(res.body.rejected[0].receipt_id).toBe('22222222-2222-2222-2222-222222222222');
        expect(res.body.rejected[0].reason).toBe('INSUFFICIENT_STOCK');
    });
});
