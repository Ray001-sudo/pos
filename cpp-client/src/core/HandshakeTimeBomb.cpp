// =============================================================================
// HandshakeTimeBomb.hpp/.cpp
// Offline Grace Period Enforcement System
//
// Design:
//   - On every cloud sync, server issues a signed handshake_token:
//       { issued_at, valid_until (now+14d), tenant_id, signature }
//     where signature = HMAC-SHA256(f"{issued_at}:{valid_until}:{tenant_id}", server_secret)
//
//   - The C++ client stores this token in the encrypted local_config table.
//   - On every app launch (even fully offline), HandshakeTimeBomb::evaluate() is called.
//   - If valid_until has passed AND account_status is not 'active' from a recent check,
//     the app enters degraded/blocked mode based on the current account_status.
//
// State machine (evaluated offline):
//   active            → full access
//   past_due (≤14d)   → full access with overdue banner
//   past_due (>14d)   → read-only mode (no new sales allowed)
//   suspended         → checkout blocked, show payment instructions
//   offline_timeout   → app locked completely
//   cancelled         → app locked completely
//
// Anti-tamper measures:
//   - Token is HMAC-signed by server — client cannot forge or extend it
//   - valid_until field cannot be modified (signature would break)
//   - Token stored in SQLCipher-encrypted DB — not accessible without key
//   - System clock manipulation: we track last-verified timestamp;
//     if current time is BEFORE stored last-verified, we flag clock tampering
//     and fall back to most restrictive policy (treat as suspended)
// =============================================================================
#pragma once

#include <string>
#include <cstdint>
#include <chrono>
#include <optional>
#include "db/LocalDB.hpp"
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <spdlog/spdlog.h>

namespace pos::core {

enum class AccessLevel {
    FullAccess,           // active — no restrictions
    OverdueBanner,        // past_due 1-14 days — banner shown, full functionality
    ReadOnly,             // past_due >14 days — no new sales
    CheckoutBlocked,      // suspended — no checkout, read-only reports
    FullyLocked           // offline_timeout / cancelled — app cannot be used
};

struct HandshakeToken {
    int64_t     issued_at;
    int64_t     valid_until;
    std::string tenant_id;
    std::string signature;
};

class HandshakeTimeBomb {
public:
    explicit HandshakeTimeBomb(db::LocalDB& db, const std::string& hmacSecret);

    // Store a new handshake token received from the cloud API
    void storeToken(const HandshakeToken& token);

    // Evaluate current access level (called on every startup and periodic check)
    AccessLevel evaluate();

    // True if cloud was reachable in this session (updated by SyncEngine)
    void setOnlineStatus(bool online) { isOnline_ = online; }

    // Get human-readable reason for current restriction
    std::string getRestrictionMessage() const { return restrictionMessage_; }

    // Days remaining before next downgrade (shown in UI)
    int daysUntilNextDowngrade() const { return daysUntilDowngrade_; }

private:
    db::LocalDB&  db_;
    std::string   hmacSecret_;
    bool          isOnline_ = false;
    std::string   restrictionMessage_;
    int           daysUntilDowngrade_ = -1;

    // Verify HMAC-SHA256 signature on handshake token
    bool verifyTokenSignature(const HandshakeToken& token);

    // Detect system clock rollback (anti-tamper)
    bool isClockTampered(int64_t currentTime);

    // Derive AccessLevel from account_status string and days_overdue
    AccessLevel levelFromStatus(const std::string& status, int daysOverdue);

    // Config keys
    static constexpr const char* KEY_VALID_UNTIL       = "handshake_valid_until";
    static constexpr const char* KEY_LAST_VERIFIED      = "handshake_last_verified";
    static constexpr const char* KEY_SIGNATURE          = "handshake_signature";
    static constexpr const char* KEY_TENANT_ID          = "tenant_id";
    static constexpr const char* KEY_ISSUED_AT          = "handshake_issued_at";
    static constexpr const char* KEY_ACCOUNT_STATUS     = "account_status";
    static constexpr const char* KEY_DAYS_OVERDUE       = "days_overdue";
};

// =============================================================================
// Implementation
// =============================================================================

HandshakeTimeBomb::HandshakeTimeBomb(db::LocalDB& db, const std::string& hmacSecret)
    : db_(db), hmacSecret_(hmacSecret) {}

void HandshakeTimeBomb::storeToken(const HandshakeToken& token) {
    if (!verifyTokenSignature(token)) {
        spdlog::error("[TimeBomb] Received handshake token with invalid signature — ignoring");
        return;
    }

    db_.setConfig(KEY_VALID_UNTIL,  std::to_string(token.valid_until));
    db_.setConfig(KEY_ISSUED_AT,    std::to_string(token.issued_at));
    db_.setConfig(KEY_SIGNATURE,    token.signature);

    int64_t now = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    db_.setConfig(KEY_LAST_VERIFIED, std::to_string(now));

    spdlog::info("[TimeBomb] Handshake token stored. Valid until epoch {}", token.valid_until);
}

bool HandshakeTimeBomb::verifyTokenSignature(const HandshakeToken& token) {
    std::string payload = std::to_string(token.issued_at) + ":" +
                          std::to_string(token.valid_until) + ":" +
                          token.tenant_id;

    unsigned char rawHmac[EVP_MAX_MD_SIZE];
    unsigned int  hmacLen = 0;

    HMAC(EVP_sha256(),
         hmacSecret_.c_str(), static_cast<int>(hmacSecret_.size()),
         reinterpret_cast<const unsigned char*>(payload.c_str()),
         payload.size(),
         rawHmac, &hmacLen);

    // Convert to hex
    char computedHex[EVP_MAX_MD_SIZE * 2 + 1];
    for (unsigned int i = 0; i < hmacLen; ++i)
        snprintf(computedHex + i * 2, 3, "%02x", rawHmac[i]);

    std::string computed(computedHex, hmacLen * 2);

    // Constant-time comparison
    if (computed.size() != token.signature.size()) return false;

    int diff = 0;
    for (size_t i = 0; i < computed.size(); ++i)
        diff |= (computed[i] ^ token.signature[i]);

    return diff == 0;
}

bool HandshakeTimeBomb::isClockTampered(int64_t currentTime) {
    auto lastVerifiedOpt = db_.getConfig(KEY_LAST_VERIFIED);
    if (!lastVerifiedOpt) return false;  // First run

    int64_t lastVerified = std::stoll(*lastVerifiedOpt);

    // Allow up to 5 minutes of NTP drift; anything else is suspicious
    if (currentTime < lastVerified - 300) {
        spdlog::warn("[TimeBomb] CLOCK TAMPERING DETECTED: current={}, last_verified={}", 
                     currentTime, lastVerified);
        return true;
    }
    return false;
}

AccessLevel HandshakeTimeBomb::evaluate() {
    int64_t now = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    // --- Anti-tamper: check for clock rollback ---
    if (isClockTampered(now)) {
        restrictionMessage_ = "System clock anomaly detected. Please contact support.";
        return AccessLevel::CheckoutBlocked;
    }

    // Update last_verified monotonic marker
    db_.setConfig(KEY_LAST_VERIFIED, std::to_string(now));

    // --- If online, cloud already returned fresh status via heartbeat ---
    auto accountStatusOpt = db_.getConfig(KEY_ACCOUNT_STATUS);
    auto daysOverdueOpt   = db_.getConfig(KEY_DAYS_OVERDUE);

    std::string accountStatus = accountStatusOpt.value_or("suspended");
    int daysOverdue = daysOverdueOpt ? std::stoi(*daysOverdueOpt) : 0;

    // --- Check handshake token validity ---
    auto validUntilOpt  = db_.getConfig(KEY_VALID_UNTIL);
    auto signatureOpt   = db_.getConfig(KEY_SIGNATURE);
    auto tenantIdOpt    = db_.getConfig(KEY_TENANT_ID);
    auto issuedAtOpt    = db_.getConfig(KEY_ISSUED_AT);

    bool tokenExpired = true;

    if (validUntilOpt && signatureOpt && tenantIdOpt && issuedAtOpt) {
        int64_t validUntil = std::stoll(*validUntilOpt);

        // Re-verify the stored token signature (prevents DB tampering)
        HandshakeToken storedToken;
        storedToken.issued_at   = std::stoll(*issuedAtOpt);
        storedToken.valid_until = validUntil;
        storedToken.tenant_id   = *tenantIdOpt;
        storedToken.signature   = *signatureOpt;

        if (verifyTokenSignature(storedToken)) {
            tokenExpired = (now > validUntil);
            daysUntilDowngrade_ = static_cast<int>((validUntil - now) / 86400);
        } else {
            spdlog::error("[TimeBomb] Stored token signature INVALID — treating as expired");
            tokenExpired = true;
        }
    }

    // --- If token is expired and we're offline, apply strict policy ---
    if (tokenExpired && !isOnline_) {
        spdlog::warn("[TimeBomb] Handshake token expired and offline — enforcing strict policy");

        // Token expired means grace period ended — must be suspended at minimum
        if (accountStatus == "active" || accountStatus == "past_due") {
            // Downgrade to suspended since we can't verify
            accountStatus = "suspended";
        }
    }

    return levelFromStatus(accountStatus, daysOverdue);
}

AccessLevel HandshakeTimeBomb::levelFromStatus(const std::string& status, int daysOverdue) {
    if (status == "active") {
        restrictionMessage_.clear();
        return AccessLevel::FullAccess;
    }

    if (status == "past_due") {
        if (daysOverdue <= 14) {
            restrictionMessage_ = "Payment overdue (" + std::to_string(daysOverdue) +
                " days). Please settle to avoid service interruption.";
            daysUntilDowngrade_ = 14 - daysOverdue;
            return AccessLevel::OverdueBanner;
        } else {
            restrictionMessage_ = "Account severely overdue (" + std::to_string(daysOverdue) +
                " days). New sales are disabled. Please make payment immediately.";
            return AccessLevel::ReadOnly;
        }
    }

    if (status == "suspended") {
        restrictionMessage_ = "Account suspended due to non-payment. "
            "Checkout is disabled. Contact support or visit your billing portal.";
        return AccessLevel::CheckoutBlocked;
    }

    // offline_timeout or cancelled or unknown
    restrictionMessage_ = "This terminal is no longer authorized. "
        "Please contact your system administrator.";
    return AccessLevel::FullyLocked;
}

} // namespace pos::core
