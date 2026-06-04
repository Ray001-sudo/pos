#pragma once

#include <string>
#include <nlohmann/json.hpp>
#include "db/LocalDB.hpp"
#include <spdlog/spdlog.h>
#include <uuid/uuid.h>
#include <openssl/rand.h>

namespace pos::modules {

using json = nlohmann::json;

class ShiftModule {
public:
    ShiftModule(db::LocalDB& db) : db_(db) {}

    std::string generateReportId() {
        unsigned char bytes[16];
        RAND_bytes(bytes, sizeof(bytes));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        char uuid[37];
        snprintf(uuid, sizeof(uuid),
            "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            bytes[0], bytes[1], bytes[2],  bytes[3],
            bytes[4], bytes[5], bytes[6],  bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12],bytes[13],bytes[14], bytes[15]);
        return std::string(uuid);
    }

    bool openShift(const std::string& userId, double openingFloat) {
        auto terminalId = db_.getConfig("terminal_id").value_or("");
        auto now = getNow();
        db_.execute(
            "INSERT INTO local_shift_reports (report_id, terminal_id, user_id, start_time, expected_cash, report_type, is_synced) "
            "VALUES (?, ?, ?, ?, ?, 'X', 0);",
            { generateReportId(), terminalId, userId, now, std::to_string(openingFloat) }
        );
        db_.setConfig("current_shift_start", now);
        db_.setConfig("current_shift_float", std::to_string(openingFloat));
        spdlog::info("[Shift] Opened shift at {}", now);
        return true;
    }

    bool closeShift(const std::string& userId, double actualCash) {
        auto terminalId = db_.getConfig("terminal_id").value_or("");
        auto startTime = db_.getConfig("current_shift_start").value_or("");
        auto floatStr = db_.getConfig("current_shift_float").value_or("0");
        
        if (startTime.empty()) return false;

        // Calculate expected cash
        auto rows = db_.queryRows(
            "SELECT SUM(grand_total) as total_cash FROM local_transactions "
            "WHERE sale_timestamp >= ? AND payment_method = 'cash' AND is_voided = 0;",
            { startTime }
        );

        double cashSales = 0.0;
        if (!rows.empty() && !rows[0]["total_cash"].empty()) {
            cashSales = std::stod(rows[0]["total_cash"]);
        }

        double expectedCash = std::stod(floatStr) + cashSales;
        double difference = actualCash - expectedCash;
        auto now = getNow();

        db_.execute(
            "INSERT INTO local_shift_reports (report_id, terminal_id, user_id, start_time, end_time, expected_cash, actual_cash, difference, report_type, is_synced) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Z', 0);",
            { generateReportId(), terminalId, userId, startTime, now, std::to_string(expectedCash), std::to_string(actualCash), std::to_string(difference) }
        );

        db_.execute("DELETE FROM local_config WHERE key IN ('current_shift_start', 'current_shift_float');", {});
        spdlog::info("[Shift] Closed shift at {}. Expected: {}, Actual: {}, Diff: {}", now, expectedCash, actualCash, difference);
        return true;
    }

private:
    db::LocalDB& db_;

    std::string getNow() {
        auto now = std::chrono::system_clock::now();
        auto tt  = std::chrono::system_clock::to_time_t(now);
        char buf[32];
        strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&tt));
        return std::string(buf);
    }
};

} // namespace pos::modules
