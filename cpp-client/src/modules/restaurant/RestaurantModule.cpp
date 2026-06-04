// =============================================================================
// RestaurantModule.cpp — Table management + KOT workflow
// =============================================================================
#pragma once

#include <string>
#include <vector>
#include <optional>
#include <nlohmann/json.hpp>
#include "db/LocalDB.hpp"
#include "net/CloudApiClient.hpp"
#include <spdlog/spdlog.h>

namespace pos::modules {

using json = nlohmann::json;

struct TableInfo {
    std::string table_id;
    std::string table_number;
    int         capacity;
    std::string status;     // available | occupied | reserved | cleaning
    std::string current_receipt_id;
};

struct KOTItem {
    std::string product_id;
    std::string name;
    int         quantity;
    std::string notes;
};

class RestaurantModule {
public:
    RestaurantModule(db::LocalDB& db, net::CloudApiClient& api)
        : db_(db), api_(api) {}

    // Get all tables from local cache
    std::vector<TableInfo> getTables() {
        auto rows = db_.queryRows(
            "SELECT table_id, table_number, capacity, status, "
            "       COALESCE(current_receipt_id, '') as current_receipt_id "
            "FROM local_restaurant_tables ORDER BY table_number;");

        std::vector<TableInfo> tables;
        for (auto& row : rows) {
            TableInfo t;
            for (auto& [k, v] : row) {
                if      (k == "table_id")           t.table_id           = v;
                else if (k == "table_number")       t.table_number       = v;
                else if (k == "capacity")           t.capacity           = std::stoi(v);
                else if (k == "status")             t.status             = v;
                else if (k == "current_receipt_id") t.current_receipt_id = v;
            }
            tables.push_back(t);
        }
        return tables;
    }

    // Update table status locally and push to cloud
    bool updateTableStatus(const std::string& tableId, const std::string& status) {
        db_.execute(
            "UPDATE local_restaurant_tables SET status = ? WHERE table_id = ?;",
            {status, tableId}
        );

        try {
            api_.put("/api/v1/restaurant/tables/" + tableId + "/status",
                     json{{"status", status}});
        } catch (const std::exception& e) {
            spdlog::warn("[Restaurant] Table status sync deferred: {}", e.what());
        }
        return true;
    }

    // Create a Kitchen Order Ticket — saved locally and pushed to cloud
    std::string createKOT(const std::string& tableId, const std::vector<KOTItem>& items) {
        std::string kotId = generateUUID();
        auto now = currentTimestamp();

        json itemsJson = json::array();
        for (auto& i : items) {
            itemsJson.push_back({
                {"product_id", i.product_id},
                {"name",       i.name},
                {"quantity",   i.quantity},
                {"notes",      i.notes}
            });
        }

        db_.execute(
            "INSERT INTO local_kitchen_orders "
            "(kot_id, table_id, items_json, status, created_at, is_synced) "
            "VALUES (?,?,?,'pending',?,0);",
            {kotId, tableId, itemsJson.dump(), now}
        );

        // Push to cloud immediately if possible
        try {
            api_.post("/api/v1/restaurant/kot",
                      json{{"table_id", tableId}, {"items", itemsJson}});
            db_.execute(
                "UPDATE local_kitchen_orders SET is_synced = 1 WHERE kot_id = ?;",
                {kotId}
            );
        } catch (...) {
            // Will be retried by SyncEngine
        }

        return kotId;
    }

private:
    db::LocalDB&          db_;
    net::CloudApiClient&  api_;

    std::string generateUUID();       // Uses OpenSSL RAND_bytes (see CheckoutModule)
    std::string currentTimestamp();   // ISO-8601 UTC
};


// =============================================================================
// PharmacyModule.cpp — Prescription check + expiry lookups
// =============================================================================

struct DrugInfo {
    std::string product_id;
    std::string name;
    std::string batch_number;
    std::string expiry_date;
    bool        requires_prescription;
    int         stock_quantity;
};

class PharmacyModule {
public:
    explicit PharmacyModule(db::LocalDB& db) : db_(db) {}

    // Look up drug by barcode — returns nullopt if not found
    std::optional<DrugInfo> lookupDrug(const std::string& barcode) {
        auto rows = db_.queryRows(
            "SELECT product_id, name, batch_number, expiry_date, "
            "       requires_prescription, stock_quantity "
            "FROM local_products "
            "WHERE barcode = ? AND is_active = '1' LIMIT 1;",
            {barcode}
        );
        if (rows.empty()) return std::nullopt;

        DrugInfo d;
        for (auto& [k, v] : rows[0]) {
            if      (k == "product_id")             d.product_id            = v;
            else if (k == "name")                   d.name                  = v;
            else if (k == "batch_number")           d.batch_number          = v;
            else if (k == "expiry_date")            d.expiry_date           = v;
            else if (k == "requires_prescription")  d.requires_prescription = (v == "1");
            else if (k == "stock_quantity")         d.stock_quantity        = std::stoi(v);
        }
        return d;
    }

    // Get drugs expiring within `days` days
    std::vector<DrugInfo> getExpiringDrugs(int days = 30) {
        // Calculate threshold date string (simplified — compare as TEXT)
        auto now = std::chrono::system_clock::now();
        auto threshold = now + std::chrono::hours(24 * days);
        auto tt = std::chrono::system_clock::to_time_t(threshold);
        char buf[11];
        strftime(buf, sizeof(buf), "%Y-%m-%d", gmtime(&tt));

        auto rows = db_.queryRows(
            "SELECT product_id, name, batch_number, expiry_date, "
            "       requires_prescription, stock_quantity "
            "FROM local_products "
            "WHERE is_active = '1' AND stock_quantity > 0 "
            "  AND expiry_date IS NOT NULL AND expiry_date <= ? "
            "ORDER BY expiry_date ASC;",
            {std::string(buf)}
        );

        std::vector<DrugInfo> result;
        for (auto& row : rows) {
            DrugInfo d;
            for (auto& [k, v] : row) {
                if      (k == "product_id")             d.product_id            = v;
                else if (k == "name")                   d.name                  = v;
                else if (k == "batch_number")           d.batch_number          = v;
                else if (k == "expiry_date")            d.expiry_date           = v;
                else if (k == "requires_prescription")  d.requires_prescription = (v == "1");
                else if (k == "stock_quantity")         d.stock_quantity        = std::stoi(v);
            }
            result.push_back(d);
        }
        return result;
    }

    // Verify prescription flag before checkout — cashier must confirm if true
    bool requiresPrescription(const std::string& productId) {
        auto rows = db_.queryRows(
            "SELECT requires_prescription FROM local_products WHERE product_id = ? LIMIT 1;",
            {productId}
        );
        if (rows.empty()) return false;
        for (auto& [k, v] : rows[0])
            if (k == "requires_prescription") return v == "1";
        return false;
    }

private:
    db::LocalDB& db_;
};


// =============================================================================
// MembershipModule.cpp — Gym/Salon membership + appointment lookup
// =============================================================================

struct MembershipInfo {
    std::string membership_id;
    std::string customer_id;
    std::string plan_name;
    std::string start_date;
    std::string end_date;
    bool        is_active;
    bool        is_expired;
};

class MembershipModule {
public:
    explicit MembershipModule(db::LocalDB& db) : db_(db) {}

    // Check active membership for a customer (by phone or customer_id)
    std::optional<MembershipInfo> getActiveMembership(const std::string& customerId) {
        // Current date as YYYY-MM-DD
        auto now = std::chrono::system_clock::now();
        auto tt  = std::chrono::system_clock::to_time_t(now);
        char today[11];
        strftime(today, sizeof(today), "%Y-%m-%d", gmtime(&tt));

        auto rows = db_.queryRows(
            "SELECT membership_id, customer_id, plan_name, start_date, end_date, is_active "
            "FROM local_memberships "
            "WHERE customer_id = ? AND is_active = '1' AND end_date >= ? "
            "ORDER BY end_date DESC LIMIT 1;",
            {customerId, std::string(today)}
        );

        if (rows.empty()) return std::nullopt;

        MembershipInfo m;
        for (auto& [k, v] : rows[0]) {
            if      (k == "membership_id") m.membership_id = v;
            else if (k == "customer_id")   m.customer_id   = v;
            else if (k == "plan_name")     m.plan_name     = v;
            else if (k == "start_date")    m.start_date    = v;
            else if (k == "end_date")      m.end_date      = v;
            else if (k == "is_active")     m.is_active     = (v == "1");
        }
        m.is_expired = (m.end_date < std::string(today));
        return m;
    }

    // Get today's appointments for a staff member
    std::vector<json> getTodayAppointments(const std::string& staffId) {
        auto now = std::chrono::system_clock::now();
        auto tt  = std::chrono::system_clock::to_time_t(now);
        char today[11];
        strftime(today, sizeof(today), "%Y-%m-%d", gmtime(&tt));

        auto rows = db_.queryRows(
            "SELECT appointment_id, customer_id, service_name, scheduled_at, status "
            "FROM local_appointments "
            "WHERE staff_id = ? AND DATE(scheduled_at) = ? "
            "ORDER BY scheduled_at ASC;",
            {staffId, std::string(today)}
        );

        std::vector<json> appts;
        for (auto& row : rows) {
            json a;
            for (auto& [k, v] : row) a[k] = v;
            appts.push_back(a);
        }
        return appts;
    }

private:
    db::LocalDB& db_;
};

} // namespace pos::modules
