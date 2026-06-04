'use strict';

const axios = require('axios');

async function getMpesaToken() {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        throw new Error('Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET');
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    
    // Use dynamic Daraja URL
    const baseUrl = process.env.MPESA_ENV === 'production' 
        ? 'https://api.safaricom.co.ke' 
        : 'https://sandbox.safaricom.co.ke';
        
    try {
        const response = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: {
                Authorization: `Basic ${auth}`
            }
        });
        return response.data.access_token;
    } catch (err) {
        console.error('Error fetching M-Pesa OAuth token:', err.response?.data || err.message);
        throw new Error('Failed to generate M-Pesa token');
    }
}

module.exports = { getMpesaToken };
