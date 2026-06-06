# POS Platform

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-Vite-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://vitejs.dev)
[![C++20](https://img.shields.io/badge/C++-20-00599C?style=flat-square&logo=c%2B%2B&logoColor=white)](https://isocpp.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-RLS-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red?style=flat-square)]()

A production-grade, multi-tenant Point of Sale platform built for retail, restaurant, and pharmacy operations. Combines a native C++20 desktop client with cloud sync, a React management dashboard, and a Python AI analytics worker — designed to operate fully offline and sync seamlessly when connectivity is restored.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture](#2-architecture)
3. [Feature Reference](#3-feature-reference)
4. [Security Model](#4-security-model)
5. [Prerequisites](#5-prerequisites)
6. [Local Development Setup](#6-local-development-setup)
7. [Production Deployment](#7-production-deployment)
8. [Multi-Tenant Provisioning](#8-multi-tenant-provisioning)
9. [Environment Variables](#9-environment-variables)
10. [Troubleshooting](#10-troubleshooting)
11. [License](#11-license)

---

## 1. What This System Does

Most POS software either runs entirely in the browser (unreliable offline) or runs entirely on-device (no central management). This platform does both correctly.

The C++ terminal client operates at full capability with zero internet connectivity — processing sales, managing inventory, printing receipts, and running shift reports against an encrypted local database. When connectivity is available, a background sync engine reconciles all terminal activity with the cloud in real time. A React dashboard gives tenant managers remote visibility and control over every aspect of their store configuration without touching the terminal hardware.

The multi-tenant architecture supports hundreds of independent retail businesses on a single cloud instance, with PostgreSQL Row-Level Security guaranteeing at the database layer that one tenant's data can never be accessed by another — regardless of application-layer behaviour.

**Designed for:** retail chains, restaurants with KOT workflows, pharmacies, and any business requiring reliable operation in low-connectivity environments.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLOUD INFRASTRUCTURE                         │
│                                                                       │
│  ┌───────────────┐    ┌─────────────────┐    ┌─────────────────────┐ │
│  │ Admin         │    │  Node.js API    │    │  Python AI          │ │
│  │ Dashboard     │◄──►│  Express        │◄──►│  Analytics Worker   │ │
│  │ React + Vite  │    │  Port 3000      │    │  asyncpg            │ │
│  └───────────────┘    └────────┬────────┘    └─────────────────────┘ │
│                                │                         │            │
│                    ┌───────────▼─────────────────────────▼──────┐    │
│                    │      PostgreSQL  (Row-Level Security)       │    │
│                    │      Redis  (sessions · rate limiting)      │    │
│                    └────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                                 ▲
                                 │  HTTPS + HMAC-signed payloads
                                 │  Sync every 30 seconds
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    C++ POS CLIENT  (per terminal)                     │
│                                                                       │
│  ┌────────────────┐   ┌──────────────────┐   ┌─────────────────────┐ │
│  │  ImGui UI      │   │  SyncEngine      │   │  HandshakeTimeBomb  │ │
│  │  checkout      │   │  background      │   │  offline grace      │ │
│  │  inventory     │   │  thread          │   │  period enforcement │ │
│  │  shift reports │   └──────────────────┘   └─────────────────────┘ │
│  └───────┬────────┘                                                   │
│          │                                                            │
│  ┌───────▼──────────────────────────────────────────────────────┐    │
│  │  SQLCipher Local DB                                           │    │
│  │  AES-256 encryption · PBKDF2 key derived from HW fingerprint │    │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

| Component | Language | Role |
|-----------|----------|------|
| C++ POS Client | C++20, ImGui | Native desktop terminal. Offline-first, encrypted local DB, background cloud sync |
| Node.js API | Node.js 20, Express | Central cloud API. Handles auth, sync, tenant management, webhooks |
| React Dashboard | React, Vite | Tenant and superadmin management UI. Store config, staff, inventory, reports |
| Python Worker | Python, asyncpg | AI analytics: sales forecasting, demand patterns, anomaly detection |
| PostgreSQL | v15+ | Primary data store with Row-Level Security enforced at schema level |
| Redis | v7 | Session storage, rate limiting, ephemeral sync state |

---

## 3. Feature Reference

### Inventory
- Parent/child product variants (size, colour, weight, or any custom attribute)
- Component recipes and kits — sell assembled products that auto-decrement component stock
- Stock transfers between terminals and locations
- Reorder level alerts with configurable thresholds per product

### Taxation
- Custom tax groups and rates per jurisdiction
- Multiple tax brackets applied to individual products
- Tax-inclusive and tax-exclusive pricing modes
- Per-tenant tax configuration — no shared tax tables between clients

### Transactions and Invoicing
- Full quote-to-invoice conversion workflow
- Invoice payment tracking with partial payment support
- Business expense recording
- M-Pesa STK Push integration for mobile payment collection

### Staff and Access Control
- Custom roles with granular permission sets
- Maximum discount limits enforced per role
- Commission rate tracking per staff member
- Fast PIN-based cashier login — no password typing at the terminal

### CRM and Loyalty
- Supplier and customer database with full contact history
- Loyalty tier system with configurable reward point accrual
- Customer purchase history accessible at checkout

### Shift Reporting
- X Report: open shift with starting float declaration
- Z Report: close shift with expected vs. actual cash reconciliation
- Per-terminal shift history with audit trail

### Restaurant and Operations
- Kitchen Order Ticket (KOT) generation and routing
- Table management with cover tracking
- Barcode generation for products and shelf labels

### Integrations
- Webhooks for CRM platforms (Mailchimp, SMS gateways)
- M-Pesa STK Push (native, no third-party payment processor)
- REST API for third-party integrations

---

## 4. Security Model

Security is enforced at multiple independent layers. A failure at any single layer does not compromise the system.

### Database layer — PostgreSQL Row-Level Security
Every table that holds tenant data has RLS policies attached. Queries execute within a tenant context set at connection time. A bug in the application that constructs the wrong query cannot return another tenant's rows — the database engine itself filters them out.

### Transport layer — HMAC-signed sync payloads
All synchronisation requests from the C++ client to the cloud API carry an HMAC-SHA256 signature over the full request body, computed using a secret injected at build time. The API rejects any request whose signature does not match. This prevents replay attacks and payload tampering even if the HTTPS layer were compromised.

### Local storage — SQLCipher AES-256
The terminal's local SQLite database is encrypted using SQLCipher with an AES-256 key derived via PBKDF2 from the machine's hardware fingerprint (CPU ID, motherboard serial, and MAC address combined). If the physical terminal is stolen, the database cannot be decrypted on any other machine. If hardware components are replaced, the key changes and the database must be re-initialised from the cloud.

### Licensing — HandshakeTimeBomb
The C++ client performs a cryptographic handshake with the cloud API on startup and every 30 seconds during operation. If the cloud cannot be reached for more than 14 consecutive days, the terminal enters restricted mode and blocks checkout. This enforces subscription validity without preventing legitimate offline operation during short outages.

### Authentication
- Cloud API: JWT access tokens (short-lived) with Redis-backed refresh token rotation
- Terminal cashiers: PIN-based login with brute-force lockout after 5 failed attempts (15-minute lockout)
- Superadmin and tenant admin accounts: bcrypt-hashed passwords, rate-limited login endpoint

---

## 5. Prerequisites

Verify all versions before proceeding. Mismatched versions are the most common source of build failures.

**For cloud backend and dashboard:**
```bash
node --version      # Required: v20.x
docker --version    # Required: 24.0+
docker compose version  # Required: v2.20+
```

**For C++ client (additional):**
```bash
cmake --version     # Required: 3.20+
# C++20 compiler:
g++ --version       # GCC 12+ (Linux)
# or
clang++ --version   # Clang 14+ (macOS/Linux)
# or Visual Studio 2022 17.4+ (Windows)
```

**For Python analytics worker:**
```bash
python3 --version   # Required: 3.11+
```

---

## 6. Local Development Setup

Follow steps in order. Each depends on the previous completing successfully.

### Step 1 — Clone the repository
```bash
git clone https://github.com/Ray001-sudo/pos-platform.git
cd pos-platform
```

### Step 2 — Generate secrets
```bash
# RSA keypair for JWT signing
openssl genrsa -out private.pem 4096
openssl rsa -in private.pem -pubout -out public.pem

# HMAC secrets for sync and handshake (generate separately)
openssl rand -hex 64   # copy output → SYNC_HMAC_SECRET in .env
openssl rand -hex 64   # copy output → HANDSHAKE_HMAC_SECRET in .env
```

### Step 3 — Configure environment
```bash
cp .env.example .env
# Edit .env and fill in all variables
# See Section 9 — Environment Variables for the full reference
```

### Step 4 — Start infrastructure
```bash
docker compose up -d postgres redis
# Wait for both to show healthy:
docker compose ps
```

### Step 5 — Initialise the database
```bash
# Apply schema with RLS policies
psql $DATABASE_URL -f cloud_schema.sql
```

### Step 6 — Start the API server
```bash
cd backend-api
npm install
npm start
# API available at http://localhost:3000
```

### Step 7 — Start the React dashboard
```bash
cd admin-dashboard
npm install
npm run dev
# Dashboard available at http://localhost:5173
```

### Step 8 — Start the Python analytics worker
```bash
cd analytics-worker
pip install -r requirements.txt
python main.py
```

### Step 9 — Build the C++ client
```bash
cd cpp-client
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j$(nproc)
./build/pos_client
```

On first launch, enter your local API URL (`http://localhost:3000`), the Tenant ID created in the dashboard, and a Terminal ID. The client will perform an initial sync and be ready for use.

---

## 7. Production Deployment

### Minimum server specifications
- CPU: 2 vCPUs (4 recommended for 10+ concurrent tenants)
- RAM: 4 GB (8 GB recommended)
- Disk: 50 GB SSD
- OS: Ubuntu 22.04 LTS

### Step 1 — Provision the server
```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx
systemctl enable --now docker
```

### Step 2 — Deploy the application
```bash
git clone https://github.com/Ray001-sudo/pos-platform.git /var/www/pos-platform
cd /var/www/pos-platform

# Generate production secrets (same commands as local setup)
# Place private.pem and public.pem in /var/www/pos-platform/secrets/
# Fill in .env with production values

docker compose -f docker-compose.prod.yml up -d
```

### Step 3 — Configure Nginx and TLS
Point your DNS A records to the server IP before running Certbot.

```bash
# Create Nginx config for API and dashboard
# api.yourdomain.com → localhost:3000
# admin.yourdomain.com → localhost:5173 (or built static files)

certbot --nginx \
  -d api.yourdomain.com \
  -d admin.yourdomain.com \
  --non-interactive \
  --agree-tos \
  -m your@email.com
```

### Step 4 — Initialise the production database
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB \
  -f /docker-entrypoint-initdb.d/cloud_schema.sql
```

### Step 5 — Create the superadmin account
```bash
cd /var/www/pos-platform/backend-api
node scripts/create-superadmin.js
```

### Step 6 — Configure firewall
```bash
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (redirects to HTTPS)
ufw allow 443/tcp   # HTTPS
ufw deny 3000/tcp   # API — internal only, proxied by Nginx
ufw deny 5432/tcp   # PostgreSQL — never exposed publicly
ufw deny 6379/tcp   # Redis — never exposed publicly
ufw enable
```

### Step 7 — Set up automatic TLS renewal
```bash
systemctl enable certbot.timer
systemctl start certbot.timer
```

---

## 8. Multi-Tenant Provisioning

A single cloud deployment supports unlimited independent tenants. Each tenant's data is isolated at the database layer via RLS and identified by a UUID that flows through every API request.

### Provisioning a new tenant (superadmin)

1. Log into the admin dashboard at `https://admin.yourdomain.com` using superadmin credentials.
2. Navigate to **Tenants → New Tenant**.
3. Enter the business name, category (Retail / Restaurant / Pharmacy), subscription plan, and module access.
4. The system generates a unique Tenant UUID and a default Tenant Admin user. Share these credentials securely with the client.

### Tenant self-configuration

The tenant admin logs in with their Tenant UUID and configures:
- **Taxes:** jurisdiction-specific rates and groups
- **Staff:** roles with granular permissions, PIN assignment
- **Inventory:** products, variants, recipes, reorder levels
- **Store settings:** receipt branding, currency, timezone

### Terminal initialisation

Install the compiled `pos_client` binary on the client's hardware (Windows or Linux).

On first launch:
1. Enter the cloud API URL, Tenant UUID, and Terminal UUID (generated from the tenant dashboard).
2. The client calls `/api/v1/license/check`, receives a signed handshake token, and performs a full initial sync — downloading all products, staff, taxes, and settings into the local encrypted database.
3. Cashiers log in via PIN. The terminal is ready for offline operation immediately.

---

## 9. Environment Variables

All variables are defined in `.env.example`. Required variables will cause startup failure if absent.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string with SSL mode |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM file |
| `JWT_PUBLIC_KEY_PATH` | Yes | Path to RSA public key PEM file |
| `SYNC_HMAC_SECRET` | Yes | 64-byte hex secret for C++ sync payload signing |
| `HANDSHAKE_HMAC_SECRET` | Yes | 64-byte hex secret for terminal handshake |
| `MPESA_CONSUMER_KEY` | No | Safaricom Daraja API consumer key |
| `MPESA_CONSUMER_SECRET` | No | Safaricom Daraja API consumer secret |
| `MPESA_SHORTCODE` | No | M-Pesa business shortcode |
| `MPESA_PASSKEY` | No | M-Pesa Lipa Na M-Pesa passkey |
| `WEBHOOK_SECRET` | No | Secret for validating outbound webhook deliveries |
| `NODE_ENV` | No | `development` or `production`. Default: `development` |
| `PORT` | No | API server port. Default: `3000` |

---

## 10. Troubleshooting

| Symptom | Root Cause | Resolution |
|---------|-----------|------------|
| **C++ client: `Handshake failed`** | Cannot reach cloud API — network outage or wrong `POS_CLOUD_URL` | Terminal continues operating via 14-day offline grace period. Verify API URL and network connectivity. |
| **C++ client: `Checkout Blocked`** | Subscription suspended or 14-day offline grace period expired | Reconnect to internet. Superadmin must set tenant status to `active` in dashboard to refresh the handshake token. |
| **C++ client: `Database corrupted or encrypted`** | Hardware fingerprint changed (motherboard, CPU, or NIC replaced) — PBKDF2 key no longer matches | Delete the local SQLite cache file and re-run terminal initialisation to resync from cloud. |
| **C++ sync: `Transaction rejected: invalid signature`** | `SYNC_HMAC_SECRET` in the C++ binary does not match the server `.env` | Recompile the C++ client with the correct secret, or verify the server `.env` has not been rotated without a client rebuild. |
| **API: `429 Too Many Requests`** | PIN entered incorrectly 5+ times — brute-force lockout triggered | Account locked for 15 minutes automatically. Tenant admin can unlock immediately from the dashboard if urgent. |
| **API: `401 Unauthorized`** | Refresh token expired or revoked in Redis | User must log out and log back in to obtain a new token pair. |
| **Dashboard: `Tenant not found`** | Login attempted with an invalid or mistyped Tenant UUID | Verify the exact UUID from the superadmin provisioning screen. UUIDs are case-sensitive. |
| **Kafka consumer lag growing** | Analytics worker falling behind sync volume | Scale the Python worker horizontally or increase its batch processing size in `config.yaml`. |
| **PostgreSQL RLS: empty result sets on valid queries** | Session tenant context not set before query execution | Ensure the API middleware runs `SET app.current_tenant_id = $1` on every connection before any query. Check the auth middleware order in `app.js`. |

---

## 11. License

Proprietary — All rights reserved. © Hexaflow Labs.

Unauthorised copying, distribution, or modification of this software or its documentation is strictly prohibited. For licensing enquiries, contact bensonray25@gmail.com.

---

<div align="center">
<sub>Built by <a href="https://bensonray.pages.dev">Benson Ray</a> at <strong>Hexaflow Labs</strong> · Nairobi, Kenya</sub>
</div>
