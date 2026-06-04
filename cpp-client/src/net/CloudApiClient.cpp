// =============================================================================
// CloudApiClient.hpp/.cpp
// HTTPS REST client for cloud API communication
// Features:
//   - libcurl with TLS 1.2+ enforced, certificate verification always ON
//   - Automatic JWT refresh on 401
//   - HMAC-SHA256 request signing (X-Signature header) on mutating requests
//   - Configurable retry with exponential back-off (max 3 retries)
// =============================================================================
#pragma once

#include <string>
#include <functional>
#include <stdexcept>
#include <curl/curl.h>
#include <openssl/hmac.h>
#include <openssl/evp.h>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

namespace pos::net {

using json = nlohmann::json;

struct ApiException : public std::runtime_error {
    int httpStatus;
    ApiException(const std::string& msg, int status = 0)
        : std::runtime_error(msg), httpStatus(status) {}
};

class CloudApiClient {
public:
    CloudApiClient(const std::string& baseUrl,
                   const std::string& hmacSecret,
                   const std::string& caCertPath = "");
    ~CloudApiClient();

    // Non-copyable
    CloudApiClient(const CloudApiClient&) = delete;
    CloudApiClient& operator=(const CloudApiClient&) = delete;

    // Set/update access token (called after login or refresh)
    void setAccessToken(const std::string& token) { accessToken_ = token; }

    // Set refresh callback — called to re-acquire token on 401
    using RefreshCallback = std::function<std::string()>;
    void setRefreshCallback(RefreshCallback cb) { onRefresh_ = cb; }

    // HTTP methods
    json get(const std::string& path);
    json post(const std::string& path, const json& body);
    json put(const std::string& path, const json& body);
    json del(const std::string& path);

private:
    std::string     baseUrl_;
    std::string     hmacSecret_;
    std::string     caCertPath_;
    std::string     accessToken_;
    RefreshCallback onRefresh_;
    CURL*           curlHandle_;

    // Compute HMAC-SHA256 signature for request body
    std::string computeSignature(const std::string& body);

    // Core request executor
    json executeRequest(const std::string& method,
                        const std::string& path,
                        const std::string& bodyStr,
                        bool retry = true);

    // libcurl write callback
    static size_t writeCallback(char* ptr, size_t size, size_t nmemb, std::string* out);

    void configureCurl(CURL* curl, const std::string& url, const std::string& bodyStr,
                       const std::string& method, curl_slist* headers,
                       std::string* responseBody, long* httpCode);
};

// =============================================================================
// Implementation
// =============================================================================

CloudApiClient::CloudApiClient(const std::string& baseUrl,
                               const std::string& hmacSecret,
                               const std::string& caCertPath)
    : baseUrl_(baseUrl), hmacSecret_(hmacSecret), caCertPath_(caCertPath)
{
    curl_global_init(CURL_GLOBAL_DEFAULT);
    curlHandle_ = curl_easy_init();
    if (!curlHandle_) throw ApiException("Failed to initialize libcurl");
}

CloudApiClient::~CloudApiClient() {
    if (curlHandle_) curl_easy_cleanup(curlHandle_);
    curl_global_cleanup();
}

size_t CloudApiClient::writeCallback(char* ptr, size_t size, size_t nmemb, std::string* out) {
    size_t total = size * nmemb;
    out->append(ptr, total);
    return total;
}

std::string CloudApiClient::computeSignature(const std::string& body) {
    unsigned char rawHmac[EVP_MAX_MD_SIZE];
    unsigned int  len = 0;

    HMAC(EVP_sha256(),
         hmacSecret_.c_str(), static_cast<int>(hmacSecret_.size()),
         reinterpret_cast<const unsigned char*>(body.c_str()), body.size(),
         rawHmac, &len);

    char hex[EVP_MAX_MD_SIZE * 2 + 1];
    for (unsigned int i = 0; i < len; ++i)
        snprintf(hex + i * 2, 3, "%02x", rawHmac[i]);

    return std::string(hex, len * 2);
}

json CloudApiClient::get(const std::string& path) {
    return executeRequest("GET", path, "");
}

json CloudApiClient::post(const std::string& path, const json& body) {
    return executeRequest("POST", path, body.dump());
}

json CloudApiClient::put(const std::string& path, const json& body) {
    return executeRequest("PUT", path, body.dump());
}

json CloudApiClient::del(const std::string& path) {
    return executeRequest("DELETE", path, "");
}

json CloudApiClient::executeRequest(const std::string& method,
                                    const std::string& path,
                                    const std::string& bodyStr,
                                    bool retry) {
    const int MAX_RETRIES = 3;
    int attempt = 0;

    while (true) {
        ++attempt;
        std::string url = baseUrl_ + path;
        std::string responseBody;
        long httpCode = 0;

        curl_slist* headers = nullptr;
        headers = curl_slist_append(headers, "Content-Type: application/json");
        headers = curl_slist_append(headers, "Accept: application/json");

        if (!accessToken_.empty()) {
            std::string authHeader = "Authorization: Bearer " + accessToken_;
            headers = curl_slist_append(headers, authHeader.c_str());
        }

        // Sign mutating requests with HMAC
        if (!bodyStr.empty() && (method == "POST" || method == "PUT")) {
            std::string sig = "X-Signature: " + computeSignature(bodyStr);
            headers = curl_slist_append(headers, sig.c_str());
        }

        curl_easy_reset(curlHandle_);

        // TLS configuration — NEVER disable verification
        curl_easy_setopt(curlHandle_, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(curlHandle_, CURLOPT_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(curlHandle_, CURLOPT_SSLVERSION,     CURL_SSLVERSION_TLSv1_2);
        if (!caCertPath_.empty())
            curl_easy_setopt(curlHandle_, CURLOPT_CAINFO, caCertPath_.c_str());

        curl_easy_setopt(curlHandle_, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curlHandle_, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curlHandle_, CURLOPT_WRITEFUNCTION, writeCallback);
        curl_easy_setopt(curlHandle_, CURLOPT_WRITEDATA, &responseBody);
        curl_easy_setopt(curlHandle_, CURLOPT_TIMEOUT, 15L);
        curl_easy_setopt(curlHandle_, CURLOPT_CONNECTTIMEOUT, 10L);
        curl_easy_setopt(curlHandle_, CURLOPT_FOLLOWLOCATION, 0L);  // No redirects

        if (method == "POST") {
            curl_easy_setopt(curlHandle_, CURLOPT_POST, 1L);
            curl_easy_setopt(curlHandle_, CURLOPT_POSTFIELDS, bodyStr.c_str());
            curl_easy_setopt(curlHandle_, CURLOPT_POSTFIELDSIZE, bodyStr.size());
        } else if (method == "PUT") {
            curl_easy_setopt(curlHandle_, CURLOPT_CUSTOMREQUEST, "PUT");
            curl_easy_setopt(curlHandle_, CURLOPT_POSTFIELDS, bodyStr.c_str());
            curl_easy_setopt(curlHandle_, CURLOPT_POSTFIELDSIZE, bodyStr.size());
        } else if (method == "DELETE") {
            curl_easy_setopt(curlHandle_, CURLOPT_CUSTOMREQUEST, "DELETE");
        }

        CURLcode curlRc = curl_easy_perform(curlHandle_);
        curl_easy_getinfo(curlHandle_, CURLINFO_RESPONSE_CODE, &httpCode);
        curl_slist_free_all(headers);

        if (curlRc != CURLE_OK) {
            std::string errMsg = curl_easy_strerror(curlRc);
            spdlog::warn("[ApiClient] Request failed (attempt {}): {}", attempt, errMsg);

            if (retry && attempt < MAX_RETRIES) {
                // Exponential back-off: 1s, 2s, 4s
                std::this_thread::sleep_for(
                    std::chrono::milliseconds(1000 * (1 << (attempt - 1))));
                continue;
            }
            throw ApiException("Network error: " + errMsg);
        }

        // Handle 401 — try token refresh once
        if (httpCode == 401 && onRefresh_ && retry) {
            spdlog::info("[ApiClient] 401 received — attempting token refresh");
            try {
                std::string newToken = onRefresh_();
                accessToken_ = newToken;
                return executeRequest(method, path, bodyStr, false);  // no more retries
            } catch (...) {
                throw ApiException("Token refresh failed — please log in again", 401);
            }
        }

        if (httpCode < 200 || httpCode >= 300) {
            std::string errBody = responseBody.empty() ? "(empty)" : responseBody;
            spdlog::warn("[ApiClient] HTTP {} from {} {}: {}", httpCode, method, path, errBody);
            throw ApiException("HTTP " + std::to_string(httpCode) + ": " + errBody,
                               static_cast<int>(httpCode));
        }

        if (responseBody.empty()) return json{};

        try {
            return json::parse(responseBody);
        } catch (const json::parse_error& e) {
            throw ApiException("JSON parse error: " + std::string(e.what()));
        }
    }
}

} // namespace pos::net
