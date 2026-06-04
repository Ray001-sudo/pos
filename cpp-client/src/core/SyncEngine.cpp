// =============================================================================
// SyncEngine.hpp/.cpp
// Offline-first sync: queues transactions locally, uploads when online
// Also handles product delta sync from cloud
// =============================================================================
#pragma once

#include <string>
#include <vector>
#include <atomic>
#include <thread>
#include <chrono>
#include <functional>
#include "db/LocalDB.hpp"
#include "net/CloudApiClient.hpp"
#include "core/HandshakeTimeBomb.hpp"
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

namespace pos::core {

using json = nlohmann::json;

// Configuration for the sync engine
struct SyncConfig {
    int  syncIntervalSeconds  = 30;    // How often to attempt sync
    int  maxBatchSize         = 25;    // Transactions per upload batch
    int  maxRetryAttempts     = 5;     // Before marking as permanently failed
    bool enableProductSync    = true;
    bool enableHeartbeat      = true;
};

class SyncEngine {
public:
    SyncEngine(db::LocalDB& db,
               net::CloudApiClient& api,
               HandshakeTimeBomb& timeBomb,
               SyncConfig config = {});
    ~SyncEngine();

    // Start background sync thread
    void start();

    // Stop background sync thread (graceful)
    void stop();

    // Force immediate sync attempt (e.g., on manual trigger from UI)
    void triggerImmediateSync();

    // Returns true if cloud was reachable in the last sync cycle
    bool isOnline() const { return isOnline_.load(); }

    // Last sync time as ISO-8601 string
    std::string lastSyncTime() const { return lastSyncTime_; }

    // Count of unsynced transactions
    int unsyncedCount() const;

    // Callbacks for UI notification
    using SyncCompleteCallback = std::function<void(int uploaded, bool online)>;
    void setSyncCompleteCallback(SyncCompleteCallback cb) { onSyncComplete_ = cb; }

private:
    db::LocalDB&          db_;
    net::CloudApiClient&  api_;
    HandshakeTimeBomb&    timeBomb_;
    SyncConfig            config_;

    std::thread           syncThread_;
    std::atomic<bool>     running_{false};
    std::atomic<bool>     triggerNow_{false};
    std::atomic<bool>     isOnline_{false};
    std::string           lastSyncTime_;
    SyncCompleteCallback  onSyncComplete_;

    void syncLoop();
    void runSyncCycle();

    // Upload unsynced local transactions to cloud
    int uploadPendingTransactions();

    // Perform heartbeat + get fresh handshake token
    void performHeartbeat();

    // Delta sync products from cloud (only changed since last sync)
        void syncProducts();
    void syncTaxRates();
    void syncCustomers();
    void syncSuppliers();
    void syncVariants();

    // Build the JSON payload for a batch of transactions
    json buildTransactionBatch(const std::vector<db::LocalDB::Row>& rows);
};

// =============================================================================
// Implementation
// =============================================================================

SyncEngine::SyncEngine(db::LocalDB& db, net::CloudApiClient& api,
                       HandshakeTimeBomb& timeBomb, SyncConfig config)
    : db_(db), api_(api), timeBomb_(timeBomb), config_(config) {}

SyncEngine::~SyncEngine() { stop(); }

void SyncEngine::start() {
    running_ = true;
    syncThread_ = std::thread(&SyncEngine::syncLoop, this);
    spdlog::info("[SyncEngine] Started (interval={}s)", config_.syncIntervalSeconds);
}

void SyncEngine::stop() {
    running_ = false;
    if (syncThread_.joinable()) syncThread_.join();
    spdlog::info("[SyncEngine] Stopped");
}

void SyncEngine::triggerImmediateSync() {
    triggerNow_ = true;
}

int SyncEngine::unsyncedCount() const {
    auto rows = db_.queryRows(
        "SELECT COUNT(*) as cnt FROM local_transactions WHERE is_synced = '0';");
    if (rows.empty()) return 0;
    for (auto& [k, v] : rows[0])
        if (k == "cnt") return std::stoi(v);
    return 0;
}

void SyncEngine::syncLoop() {
    while (running_) {
        bool immediate = triggerNow_.exchange(false);

        if (immediate || true) {   // always try on every cycle
            runSyncCycle();
        }

        // Wait for next interval or early trigger
        for (int i = 0; i < config_.syncIntervalSeconds * 10 && running_; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (triggerNow_.load()) break;
        }
    }
}

void SyncEngine::runSyncCycle() {
    try {
        // 1. Heartbeat (refreshes JWT if needed, gets fresh status + handshake)
        if (config_.enableHeartbeat) performHeartbeat();

        // 2. Upload pending transactions
        int uploaded = uploadPendingTransactions();

        // 3. Product delta sync
                if (config_.enableProductSync) {
            syncProducts();
            syncTaxRates();
            syncCustomers();
            syncSuppliers();
            syncVariants();
        }

        // 4. Update last sync time
        auto now = std::chrono::system_clock::now();
        auto tt  = std::chrono::system_clock::to_time_t(now);
        char buf[32];
        strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&tt));
        lastSyncTime_ = buf;
        db_.setConfig("sync_last_success", lastSyncTime_);

        if (onSyncComplete_) onSyncComplete_(uploaded, isOnline_.load());

    } catch (const std::exception& e) {
        spdlog::warn("[SyncEngine] Sync cycle failed: {}", e.what());
        isOnline_ = false;
        timeBomb_.setOnlineStatus(false);
    }
}

void SyncEngine::performHeartbeat() {
    try {
        auto response = api_.post("/api/v1/sync/heartbeat", {});
        isOnline_ = true;
        timeBomb_.setOnlineStatus(true);

        // Update account_status and days_overdue in local config
        if (response.contains("account_status")) {
            db_.setConfig("account_status", response["account_status"].get<std::string>());
        }
        if (response.contains("days_overdue")) {
            db_.setConfig("days_overdue", std::to_string(response["days_overdue"].get<int>()));
        }

        // Store fresh handshake token if provided
        if (response.contains("handshake_token") && !response["handshake_token"].is_null()) {
            auto& ht = response["handshake_token"];
            HandshakeToken token;
            token.issued_at   = ht["issued_at"].get<int64_t>();
            token.valid_until = ht["valid_until"].get<int64_t>();
            token.tenant_id   = ht["tenant_id"].get<std::string>();
            token.signature   = ht["signature"].get<std::string>();
            timeBomb_.storeToken(token);
        }

        spdlog::debug("[SyncEngine] Heartbeat OK, status={}",
                      response.value("account_status", "unknown"));

    } catch (const std::exception& e) {
        isOnline_ = false;
        timeBomb_.setOnlineStatus(false);
        spdlog::debug("[SyncEngine] Heartbeat failed (offline?): {}", e.what());
    }
}

int SyncEngine::uploadPendingTransactions() {
    // Fetch unsynced transactions (up to maxBatchSize)
    auto rows = db_.queryRows(
        "SELECT receipt_id, cashier_id, subtotal, tax_total, discount_total, grand_total, "
        "       payment_method, sale_timestamp, is_voided, void_reason, items_json, sync_attempts "
        "FROM local_transactions "
        "WHERE is_synced = '0' AND sync_attempts < ? "
        "ORDER BY sale_timestamp ASC "
        "LIMIT ?;",
        {std::to_string(config_.maxRetryAttempts), std::to_string(config_.maxBatchSize)}
    );

    if (rows.empty() || !isOnline_) return 0;

    json batch = buildTransactionBatch(rows);

    try {
        auto response = api_.post("/api/v1/sync/transactions", batch);

        // Mark accepted transactions as synced
        if (response.contains("accepted")) {
            for (auto& rid : response["accepted"]) {
                std::string receiptId = rid.get<std::string>();
                db_.execute(
                    "UPDATE local_transactions SET is_synced = '1' WHERE receipt_id = ?;",
                    {receiptId}
                );
            }
        }

        // Increment retry count for rejected ones
        if (response.contains("rejected")) {
            for (auto& rej : response["rejected"]) {
                std::string receiptId = rej["receipt_id"].get<std::string>();
                std::string reason    = rej.value("reason", "unknown");
                db_.execute(
                    "UPDATE local_transactions SET sync_attempts = sync_attempts + 1, "
                    "last_sync_error = ? WHERE receipt_id = ?;",
                    {reason, receiptId}
                );
                spdlog::warn("[SyncEngine] Transaction {} rejected: {}", receiptId, reason);
            }
        }

        int uploaded = response.contains("accepted") ? static_cast<int>(response["accepted"].size()) : 0;
        spdlog::info("[SyncEngine] Uploaded {} transactions", uploaded);
        return uploaded;

    } catch (const std::exception& e) {
        // Increment retry count for all transactions in this failed batch
        for (auto& row : rows) {
            std::string receiptId;
            for (auto& [k, v] : row)
                if (k == "receipt_id") receiptId = v;

            if (!receiptId.empty()) {
                db_.execute(
                    "UPDATE local_transactions SET sync_attempts = sync_attempts + 1, "
                    "last_sync_error = ? WHERE receipt_id = ?;",
                    {std::string(e.what()), receiptId}
                );
            }
        }
        throw;
    }
}

json SyncEngine::buildTransactionBatch(const std::vector<db::LocalDB::Row>& rows) {
    json transactions = json::array();
    auto terminalId   = db_.getConfig("terminal_id").value_or("");

    for (auto& row : rows) {
        json tx;
        for (auto& [k, v] : row) {
            if      (k == "is_voided")  tx[k] = (v == "1");
            else if (k == "items_json") tx["items"] = json::parse(v);
            else                        tx[k] = v;
        }
        tx["terminal_id"] = terminalId;
        transactions.push_back(tx);
    }

    return json{{"transactions", transactions}};
}

void SyncEngine::syncProducts() {
    auto lastSynced = db_.getConfig("products_last_synced").value_or("");

    std::string url = "/api/v1/sync/products";
    if (!lastSynced.empty()) url += "?since=" + lastSynced;

    try {
        auto response = api_.get(url);
        if (!response.contains("products")) return;

        int updated = 0;
        db_.beginTransaction();
        try {
            for (auto& p : response["products"]) {
                db_.execute(
                    "INSERT INTO local_products "
                    "(product_id, name, sku, barcode, price, cost_price, stock_quantity, "
                    " category, unit, tax_rate, is_active, batch_number, expiry_date, "
                    " requires_prescription, last_synced_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(product_id) DO UPDATE SET "
                    "  name=excluded.name, sku=excluded.sku, barcode=excluded.barcode, "
                    "  price=excluded.price, cost_price=excluded.cost_price, "
                    "  stock_quantity=excluded.stock_quantity, category=excluded.category, "
                    "  unit=excluded.unit, tax_rate=excluded.tax_rate, "
                    "  is_active=excluded.is_active, batch_number=excluded.batch_number, "
                    "  expiry_date=excluded.expiry_date, "
                    "  requires_prescription=excluded.requires_prescription, "
                    "  last_synced_at=excluded.last_synced_at;",
                    {
                        p.value("product_id", ""),
                        p.value("name", ""),
                        p.value("sku", ""),
                        p.value("barcode", ""),
                        std::to_string(p.value("price", 0.0)),
                        std::to_string(p.value("cost_price", 0.0)),
                        std::to_string(p.value("stock_quantity", 0)),
                        p.value("category", ""),
                        p.value("unit", ""),
                        std::to_string(p.value("tax_rate", 0.0)),
                        p.value("is_active", true) ? "1" : "0",
                        p.value("batch_number", ""),
                        p.value("expiry_date", ""),
                        p.value("requires_prescription", false) ? "1" : "0",
                        response.value("synced_at", "")
                    }
                );
                ++updated;
            }
            db_.commitTransaction();
            db_.setConfig("products_last_synced", response.value("synced_at", ""));
            spdlog::info("[SyncEngine] Product sync: {} updated", updated);
        } catch (...) {
            db_.rollbackTransaction();
            throw;
        }
    } catch (const std::exception& e) {
        spdlog::warn("[SyncEngine] Product sync failed: {}", e.what());
    }
}


void SyncEngine::syncTaxRates() {
    auto lastSynced = db_.getConfig("tax_rates_last_synced").value_or("");
    std::string url = "/api/v1/sync/tax_rates";
    if (!lastSynced.empty()) url += "?since=" + lastSynced;
    try {
        auto response = api_.get(url);
        if (!response.contains("rates")) return;
        db_.beginTransaction();
        try {
            for (auto& r : response["rates"]) {
                db_.execute(
                    "INSERT INTO local_tax_rates (rate_id, group_id, name, percentage) "
                    "VALUES (?,?,?,?) ON CONFLICT(rate_id) DO UPDATE SET "
                    "group_id=excluded.group_id, name=excluded.name, percentage=excluded.percentage;",
                    { r.value("rate_id", ""), r.value("group_id", ""), r.value("name", ""), std::to_string(r.value("percentage", 0.0)) }
                );
            }
            db_.commitTransaction();
            db_.setConfig("tax_rates_last_synced", response.value("synced_at", ""));
        } catch (...) { db_.rollbackTransaction(); }
    } catch (...) {}
}

void SyncEngine::syncCustomers() {
    auto lastSynced = db_.getConfig("customers_last_synced").value_or("");
    std::string url = "/api/v1/sync/customers";
    if (!lastSynced.empty()) url += "?since=" + lastSynced;
    try {
        auto response = api_.get(url);
        if (!response.contains("customers")) return;
        db_.beginTransaction();
        try {
            for (auto& c : response["customers"]) {
                db_.execute(
                    "INSERT INTO local_customers (customer_id, name, phone, email, loyalty_points, loyalty_tier) "
                    "VALUES (?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET "
                    "name=excluded.name, phone=excluded.phone, email=excluded.email, loyalty_points=excluded.loyalty_points, loyalty_tier=excluded.loyalty_tier;",
                    { c.value("customer_id", ""), c.value("name", ""), c.value("phone", ""), c.value("email", ""), std::to_string(c.value("loyalty_points", 0)), c.value("loyalty_tier", "bronze") }
                );
            }
            db_.commitTransaction();
            db_.setConfig("customers_last_synced", response.value("synced_at", ""));
        } catch (...) { db_.rollbackTransaction(); }
    } catch (...) {}
}

void SyncEngine::syncSuppliers() {
    // simplified
}

void SyncEngine::syncVariants() {
    // simplified
}

} // namespace pos::core
