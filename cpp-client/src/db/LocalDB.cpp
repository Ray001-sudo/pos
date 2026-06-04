// =============================================================================
// LocalDB.hpp — SQLCipher-encrypted local database wrapper
// Key derivation: PBKDF2-SHA256 from hardware fingerprint, 100,000 iterations
// =============================================================================
#pragma once

#include <string>
#include <vector>
#include <functional>
#include <stdexcept>
#include <optional>
#include "sqlcipher/sqlite3.h"
#include <openssl/evp.h>
#include <openssl/sha.h>
#include <spdlog/spdlog.h>
#include "security/HardwareFingerprint.hpp"

namespace pos::db {

struct DBException : public std::runtime_error {
    explicit DBException(const std::string& msg) : std::runtime_error(msg) {}
};

// =============================================================================
// LocalDB — thread-safe SQLCipher database access
// =============================================================================
class LocalDB {
public:
    explicit LocalDB(const std::string& dbPath);
    ~LocalDB();

    // Non-copyable, non-movable (singleton-like per process)
    LocalDB(const LocalDB&) = delete;
    LocalDB& operator=(const LocalDB&) = delete;

    // Open + unlock with hardware-derived key
    void open();
    void close();
    bool isOpen() const { return db_ != nullptr; }

    // Execute SQL with no return value (CREATE, INSERT, UPDATE, DELETE)
    void execute(const std::string& sql,
                 const std::vector<std::string>& params = {});

    // Query with callback: callback(column_names, row_values) per row
    using RowCallback = std::function<void(
        const std::vector<std::string>& cols,
        const std::vector<std::string>& values)>;
    void query(const std::string& sql,
               const std::vector<std::string>& params,
               RowCallback callback);

    // Convenience: query returning rows as vector of maps
    using Row = std::vector<std::pair<std::string,std::string>>;
    std::vector<Row> queryRows(const std::string& sql,
                               const std::vector<std::string>& params = {});

    // Config key-value helpers
    void setConfig(const std::string& key, const std::string& value);
    std::optional<std::string> getConfig(const std::string& key);

    // RAII transaction scope
    void beginTransaction();
    void commitTransaction();
    void rollbackTransaction();

    // Apply schema migrations
    void applySchema(const std::string& schemaSql);

private:
    std::string dbPath_;
    sqlite3*    db_ = nullptr;
    std::string derivedKey_;

    // Derive AES-256 encryption key from hardware fingerprint via PBKDF2-SHA256
    std::string deriveEncryptionKey(const std::string& fingerprint);

    // Bind parameters to a prepared statement (all as TEXT for simplicity;
    // SQLite coerces as needed based on column affinity)
    void bindParams(sqlite3_stmt* stmt, const std::vector<std::string>& params);

    // SQLCipher key pragma (called immediately after open)
    void setKey(const std::string& key);

    // Re-key the database (used when fingerprint changes — migration path)
    void rekey(const std::string& newKey);
};

} // namespace pos::db

// =============================================================================
// LocalDB.cpp
// =============================================================================
// #include "db/LocalDB.hpp"

namespace pos::db {

// ---------------------------------------------------------------------------
// Derive encryption key using PBKDF2-SHA256
// Input: hardware fingerprint string (CPU serial + MB serial + MAC addr)
// Output: 64-char hex string (256-bit key)
// ---------------------------------------------------------------------------
std::string LocalDB::deriveEncryptionKey(const std::string& fingerprint) {
    const char* SALT = "POS_SQLCIPHER_SALT_v1";
    const int   ITERATIONS = 100000;
    const int   KEY_LEN    = 32;   // 256 bits

    unsigned char outKey[KEY_LEN];
    int rc = PKCS5_PBKDF2_HMAC(
        fingerprint.c_str(), static_cast<int>(fingerprint.size()),
        reinterpret_cast<const unsigned char*>(SALT), static_cast<int>(strlen(SALT)),
        ITERATIONS,
        EVP_sha256(),
        KEY_LEN, outKey
    );

    if (rc != 1) throw DBException("PBKDF2 key derivation failed");

    // Convert to hex string
    char hex[KEY_LEN * 2 + 1];
    for (int i = 0; i < KEY_LEN; ++i)
        snprintf(hex + i * 2, 3, "%02x", outKey[i]);

    return std::string(hex, KEY_LEN * 2);
}

LocalDB::LocalDB(const std::string& dbPath) : dbPath_(dbPath) {}

LocalDB::~LocalDB() {
    close();
}

void LocalDB::open() {
    // 1. Get hardware fingerprint
    security::HardwareFingerprint hwfp;
    std::string fingerprint = hwfp.generate();

    // 2. Derive encryption key
    derivedKey_ = deriveEncryptionKey(fingerprint);

    // 3. Open SQLCipher database
    int rc = sqlite3_open_v2(
        dbPath_.c_str(), &db_,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        nullptr
    );
    if (rc != SQLITE_OK) {
        std::string err = db_ ? sqlite3_errmsg(db_) : "unknown error";
        sqlite3_close(db_);
        db_ = nullptr;
        throw DBException("Failed to open database: " + err);
    }

    // 4. Set the encryption key (MUST be first pragma after open)
    setKey(derivedKey_);

    // 5. Enable WAL mode and foreign keys
    execute("PRAGMA journal_mode = WAL;");
    execute("PRAGMA foreign_keys = ON;");
    execute("PRAGMA synchronous = NORMAL;");
    execute("PRAGMA busy_timeout = 5000;");

    spdlog::info("LocalDB opened at {}", dbPath_);
}

void LocalDB::setKey(const std::string& key) {
    // SQLCipher key pragma: "PRAGMA key = \"x'<hex>'\""
    std::string pragma = "PRAGMA key = \"x'" + key + "'\";";
    char* errMsg = nullptr;
    int rc = sqlite3_exec(db_, pragma.c_str(), nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::string err = errMsg ? errMsg : "unknown";
        sqlite3_free(errMsg);
        throw DBException("Failed to set SQLCipher key: " + err);
    }
}

void LocalDB::close() {
    if (db_) {
        sqlite3_close_v2(db_);
        db_ = nullptr;
    }
    // Zero out derived key in memory
    std::fill(derivedKey_.begin(), derivedKey_.end(), '\0');
}

void LocalDB::bindParams(sqlite3_stmt* stmt, const std::vector<std::string>& params) {
    for (int i = 0; i < static_cast<int>(params.size()); ++i) {
        int rc = sqlite3_bind_text(stmt, i + 1,
            params[i].c_str(), static_cast<int>(params[i].size()),
            SQLITE_TRANSIENT);
        if (rc != SQLITE_OK)
            throw DBException("Failed to bind param " + std::to_string(i + 1));
    }
}

void LocalDB::execute(const std::string& sql, const std::vector<std::string>& params) {
    if (!db_) throw DBException("Database not open");

    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr);
    if (rc != SQLITE_OK)
        throw DBException("SQL prepare error: " + std::string(sqlite3_errmsg(db_)));

    bindParams(stmt, params);

    rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
        throw DBException("SQL execute error: " + std::string(sqlite3_errmsg(db_)));
    }
}

void LocalDB::query(const std::string& sql,
                    const std::vector<std::string>& params,
                    RowCallback callback) {
    if (!db_) throw DBException("Database not open");

    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr);
    if (rc != SQLITE_OK)
        throw DBException("SQL prepare error: " + std::string(sqlite3_errmsg(db_)));

    bindParams(stmt, params);

    int colCount = sqlite3_column_count(stmt);
    std::vector<std::string> cols;
    cols.reserve(colCount);
    for (int i = 0; i < colCount; ++i)
        cols.push_back(sqlite3_column_name(stmt, i));

    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        std::vector<std::string> values;
        values.reserve(colCount);
        for (int i = 0; i < colCount; ++i) {
            const char* txt = reinterpret_cast<const char*>(sqlite3_column_text(stmt, i));
            values.push_back(txt ? txt : "");
        }
        callback(cols, values);
    }

    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE)
        throw DBException("SQL step error: " + std::string(sqlite3_errmsg(db_)));
}

std::vector<LocalDB::Row> LocalDB::queryRows(const std::string& sql,
                                              const std::vector<std::string>& params) {
    std::vector<Row> result;
    query(sql, params, [&result](const std::vector<std::string>& cols,
                                  const std::vector<std::string>& vals) {
        Row row;
        for (size_t i = 0; i < cols.size(); ++i)
            row.emplace_back(cols[i], vals[i]);
        result.push_back(std::move(row));
    });
    return result;
}

void LocalDB::setConfig(const std::string& key, const std::string& value) {
    execute(
        "INSERT INTO local_config (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        {key, value}
    );
}

std::optional<std::string> LocalDB::getConfig(const std::string& key) {
    auto rows = queryRows("SELECT value FROM local_config WHERE key = ?;", {key});
    if (rows.empty()) return std::nullopt;
    return rows[0][0].second;
}

void LocalDB::beginTransaction()  { execute("BEGIN;"); }
void LocalDB::commitTransaction()  { execute("COMMIT;"); }
void LocalDB::rollbackTransaction(){ execute("ROLLBACK;"); }

void LocalDB::applySchema(const std::string& schemaSql) {
    char* errMsg = nullptr;
    int rc = sqlite3_exec(db_, schemaSql.c_str(), nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::string err = errMsg ? errMsg : "unknown";
        sqlite3_free(errMsg);
        throw DBException("Schema apply error: " + err);
    }
}

} // namespace pos::db
