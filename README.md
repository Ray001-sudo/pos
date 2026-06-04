# POS Platform — Multi-Tenant Point of Sale System

A production-grade, multi-tenant POS platform with cloud sync, offline-first C++ client, AI analytics, and a comprehensive superadmin/tenant dashboard.

---

## 🌟 Features Overview

The platform supports an extensive array of business operations, categorized into modular features:

1. **Inventory Management (Kits & Variants):** Supports parent/child variants (e.g., Size, Color), component recipes (Kits), stock transfers between terminals, and reorder level alerts.
2. **Advanced Taxation:** Create custom Tax Groups and Rates, seamlessly applying multiple tax brackets to individual products.
3. **Transactions & Invoicing:** Generate Quotes and Invoices, convert quotes to invoices, track invoice payments, and record business expenses.
4. **Staff Controls & Custom Roles:** Create custom roles with granular permissions, enforce maximum discount limits, track commission rates, and allow fast PIN-based login for cashiers.
5. **CRM & Loyalty:** Maintain a database of Suppliers and Customers, with loyalty tier tracking and reward points.
6. **Shift Reporting (X/Z Reports):** Native terminal shift tracking. Open shifts with a starting float (X report) and close shifts calculating expected cash vs. actual cash (Z report).
7. **Operations & Restaurant:** Support for Kitchen Order Tickets (KOT), table management, and barcode generation.
8. **Connectivity & Payments:** Direct M-Pesa STK Push integrations natively supported.
9. **Modern SaaS Tools:** Webhooks for CRM integrations (Mailchimp, SMS gateways), and an integrated React Dashboard for Tenant Managers to configure their store settings remotely.

---

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLOUD INFRASTRUCTURE                         │
│                                                                      │
│  ┌──────────────┐    ┌────────────────┐    ┌─────────────────────┐  │
│  │ Admin        │    │  Node.js API   │    │  Python AI          │  │
│  │ Dashboard    │◄──►│  (Express)     │◄──►│  Analytics Worker   │  │
│  │ (React/Vite) │    │  Port 3000     │    │  (asyncpg)          │  │
│  └──────────────┘    └───────┬────────┘    └─────────────────────┘  │
│                               │                        │             │
│                        ┌──────▼────────────────────────▼──────┐     │
│                        │         PostgreSQL (RLS enforced)     │     │
│                        │         + Redis (sessions/rate limit) │     │
│                        └───────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
                                ▲  HTTPS + HMAC
                                │  (sync every 30s)
┌──────────────────────────────┼──────────────────────────────────────┐
│                     C++ POS CLIENT (per terminal)                    │
│                                                                      │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────┐ │
│  │ ImGui UI     │  │ SyncEngine     │  │ HandshakeTimeBomb        │ │
│  │ (checkout,   │  │ (background    │  │ (offline enforcement)    │ │
│  │  inventory,  │  │  thread)       │  │                          │ │
│  │  reports)    │  └────────────────┘  └──────────────────────────┘ │
│  └──────────────┘                                                    │
│         │                                                            │
│  ┌──────▼───────────────────────────────────────────────────────┐   │
│  │  SQLCipher Local DB (AES-256, PBKDF2 key from HW fingerprint) │   │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Deployment Guide

### 1. Local Machine Deployment (Development)

**Prerequisites:** Docker, Docker Compose, Node.js 20, CMake, C++20 Compiler.

1. **Clone the Repository**
2. **Generate Secrets**
   ```bash
   openssl genrsa -out private.pem 4096
   openssl rsa -in private.pem -pubout -out public.pem
   openssl rand -hex 64 # SYNC_HMAC_SECRET
   openssl rand -hex 64 # HANDSHAKE_HMAC_SECRET
   ```
3. **Configure Environment**
   Copy `.env.example` to `.env` and fill in your generated secrets and local DB credentials.
4. **Start Cloud Backend**
   ```bash
   docker compose up -d postgres redis
   cd backend-api && npm install && npm start
   ```
5. **Start React Dashboard**
   ```bash
   cd admin-dashboard && npm install && npm run dev
   ```
6. **Compile C++ Client**
   ```bash
   cd cpp-client
   cmake -B build -DCMAKE_BUILD_TYPE=Release
   cmake --build build -j$(nproc)
   ```

### 2. DigitalOcean Deployment (Production)

**Prerequisites:** A DigitalOcean Droplet (Ubuntu 22.04 LTS, 4GB RAM minimum), Domain Name.

1. **Server Setup**
   SSH into your droplet, install Docker, Docker Compose, and Nginx.
   ```bash
   sudo apt update && sudo apt install docker.io docker-compose nginx certbot python3-certbot-nginx -y
   ```
2. **Transfer Files & Secrets**
   Clone the repo to `/var/www/pos-platform`. Generate secure RSA/HMAC keys as shown in the Local setup and place them in the `.env` file securely.
3. **Configure Nginx & SSL**
   Set up Nginx as a reverse proxy forwarding requests to the Node.js API (port 3000) and serving the React built files.
   Run `sudo certbot --nginx -d api.yourdomain.com -d admin.yourdomain.com` to secure with Let's Encrypt TLS 1.2+.
4. **Deploy Containers**
   ```bash
   cd /var/www/pos-platform
   docker-compose -f docker-compose.prod.yml up -d
   ```
5. **Database Initialization**
   Run the schema scripts (`cloud_schema.sql`) against the managed PostgreSQL database ensuring Row-Level Security is active.

---

## 🏢 Setting Up the POS for Different Clients (Tenants)

The system is fiercely multi-tenant. A single cloud instance supports hundreds of retail clients securely.

1. **Super Admin Provisioning:**
   - Log into the React Admin Dashboard (`admin.yourdomain.com`) using Super Admin credentials.
   - Navigate to **Tenants > New Tenant**.
   - Input the Client's Business Name, Category, Subscription Plan, and configure which Modules they have access to (e.g., Pharmacy, Restaurant).
   - This provisions their secure Tenant ID and generates a default Admin User for them.

2. **Tenant Configuration:**
   - The Client (Tenant Admin) logs into the dashboard using their specific `Tenant ID`.
   - They use the **Tenant Dashboard** to set up:
     - **Taxes:** Create default tax rates for their jurisdiction.
     - **Staff:** Create custom roles (Cashier, Manager) and issue PINs.
     - **Inventory:** Import/create products, variants, and recipes.

3. **Terminal Initialization:**
   - Install the compiled `pos_client` executable on the Client's physical Windows/Linux hardware.
   - On first boot, input the `Tenant ID` and `Terminal ID` (generated from the Dashboard).
   - The C++ client connects to `/api/v1/license/check`, downloads the `HANDSHAKE_TOKEN`, and performs an initial sync of all products, taxes, and settings into the local encrypted SQLite DB.
   - Cashiers can now log in via PIN and operate fully offline.

---

## 🛠 Troubleshooting & Common Errors

| Symptom / Error | Root Cause | Resolution |
|----------------|------------|------------|
| **C++ Client: `Handshake failed (offline?)`** | Client cannot reach the cloud API due to network outage or invalid `POS_CLOUD_URL`. | The terminal will continue working offline via the `HandshakeTimeBomb` grace period (14 days). Verify network connection and API URL. |
| **C++ Client: `Access Level: Checkout Blocked`** | The client's subscription is `suspended` or the 14-day offline grace period expired. | Reconnect to the internet and ensure the Super Admin has marked the tenant account as `active` to refresh the JWT. |
| **API Error: `429 Too Many Requests`** | A cashier entered the wrong PIN >5 times, triggering brute-force lock. | The account is locked for 15 minutes. A Tenant Admin can manually reset this from the dashboard if urgent. |
| **API Error: `401 Unauthorized`** | The React UI's `REFRESH_TOKEN_COOKIE` expired or was revoked. | The user must log out and log back in. |
| **C++ Sync: `Transaction rejected: invalid signature`** | The HMAC signature on the payload does not match the server. | Ensure the `SYNC_HMAC_SECRET` injected into the C++ binary matches the `.env` on the Node.js server perfectly. |
| **React Dashboard: `Tenant not found`** | Attempting to login with an invalid UUID for the Tenant ID. | Ensure the Tenant ID exactly matches the UUID provisioned in the Super Admin dashboard. |
| **C++ Client: `Database corrupted or encrypted`** | The hardware fingerprint changed (e.g., motherboard swapped), changing the SQLite AES key. | You must delete the local SQLite cache and perform a fresh terminal initialization to redownload cloud data. |

---

## Security Highlights
- **PostgreSQL RLS:** Row-Level Security guarantees a bug in the application layer cannot expose another tenant's data.
- **SQLCipher AES-256:** Local terminal databases are encrypted using hardware fingerprints. Data cannot be extracted if the physical POS machine is stolen.
- **HMAC Signatures:** All sync requests are tamper-proofed with HMAC.

## License
Proprietary — All rights reserved.
