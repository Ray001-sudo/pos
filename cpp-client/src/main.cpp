// =============================================================================
// HardwareFingerprint.hpp/.cpp
// Generates a stable per-machine fingerprint from:
//   - CPU identifier (Linux: /proc/cpuinfo; Windows: registry; macOS: IOKit)
//   - Motherboard serial (Linux: dmidecode / /sys/class/dmi; Windows: WMI)
//   - Primary NIC MAC address
// Output: SHA-256 hex digest of the combined raw identifiers
// =============================================================================
#pragma once

#include <string>
#include <fstream>
#include <sstream>
#include <array>
#include <openssl/sha.h>
#include <spdlog/spdlog.h>

#ifdef _WIN32
  #include <windows.h>
  #include <iphlpapi.h>
  #pragma comment(lib, "iphlpapi.lib")
#elif defined(__APPLE__)
  #include <IOKit/IOKitLib.h>
  #include <net/if.h>
  #include <ifaddrs.h>
  #include <net/if_dl.h>
#else  // Linux
  #include <net/if.h>
  #include <sys/ioctl.h>
  #include <netinet/in.h>
  #include <net/if_arp.h>
  #include <unistd.h>
#endif

namespace pos::security {

class HardwareFingerprint {
public:
    // Returns SHA-256 hex digest of hardware identifiers
    std::string generate();

private:
    std::string getCpuId();
    std::string getMotherboardSerial();
    std::string getMacAddress();
    std::string sha256Hex(const std::string& input);
};

// =============================================================================
// Linux Implementation
// =============================================================================
#ifdef __linux__

std::string HardwareFingerprint::getCpuId() {
    std::ifstream f("/proc/cpuinfo");
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("Serial", 0) == 0 || line.rfind("Hardware", 0) == 0) {
            auto pos = line.find(':');
            if (pos != std::string::npos)
                return line.substr(pos + 2);
        }
    }
    // Fallback: use model name as stable identifier
    std::ifstream f2("/proc/cpuinfo");
    while (std::getline(f2, line)) {
        if (line.rfind("model name", 0) == 0) {
            auto pos = line.find(':');
            if (pos != std::string::npos)
                return line.substr(pos + 2);
        }
    }
    return "unknown_cpu";
}

std::string HardwareFingerprint::getMotherboardSerial() {
    // Try DMI product_serial (requires read access; may need root or group permission)
    const std::vector<std::string> paths = {
        "/sys/class/dmi/id/product_serial",
        "/sys/class/dmi/id/board_serial",
        "/sys/class/dmi/id/product_uuid"
    };
    for (auto& p : paths) {
        std::ifstream f(p);
        if (f.is_open()) {
            std::string val;
            std::getline(f, val);
            if (!val.empty() && val != "Not Specified" && val != "To be filled by O.E.M.") {
                return val;
            }
        }
    }
    return "unknown_board";
}

std::string HardwareFingerprint::getMacAddress() {
    // Iterate network interfaces, skip loopback, return first MAC
    struct if_nameindex* ifc = if_nameindex();
    if (!ifc) return "unknown_mac";

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) { if_freenameindex(ifc); return "unknown_mac"; }

    std::string mac = "unknown_mac";
    for (auto* it = ifc; it->if_name != nullptr; ++it) {
        struct ifreq req{};
        strncpy(req.ifr_name, it->if_name, IFNAMSIZ - 1);
        if (ioctl(sock, SIOCGIFHWADDR, &req) < 0) continue;
        if (req.ifr_hwaddr.sa_family != ARPHRD_ETHER) continue;

        unsigned char* hw = reinterpret_cast<unsigned char*>(req.ifr_hwaddr.sa_data);
        // Skip all-zero MACs
        if (hw[0] == 0 && hw[1] == 0 && hw[2] == 0) continue;

        char buf[18];
        snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
                 hw[0], hw[1], hw[2], hw[3], hw[4], hw[5]);
        mac = buf;
        break;
    }

    close(sock);
    if_freenameindex(ifc);
    return mac;
}

#elif defined(_WIN32)

std::string HardwareFingerprint::getCpuId() {
    int cpuInfo[4] = {};
    __cpuid(cpuInfo, 1);
    char buf[32];
    snprintf(buf, sizeof(buf), "%08x%08x%08x%08x",
             cpuInfo[0], cpuInfo[1], cpuInfo[2], cpuInfo[3]);
    return std::string(buf);
}

std::string HardwareFingerprint::getMotherboardSerial() {
    HKEY hKey;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Cryptography", 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        char val[256] = {};
        DWORD sz = sizeof(val);
        RegQueryValueExA(hKey, "MachineGuid", nullptr, nullptr,
                         reinterpret_cast<LPBYTE>(val), &sz);
        RegCloseKey(hKey);
        if (strlen(val) > 0) return val;
    }
    return "unknown_board";
}

std::string HardwareFingerprint::getMacAddress() {
    ULONG size = 0;
    GetAdaptersInfo(nullptr, &size);
    std::vector<char> buf(size);
    auto* ai = reinterpret_cast<IP_ADAPTER_INFO*>(buf.data());
    if (GetAdaptersInfo(ai, &size) == ERROR_SUCCESS) {
        char mac[18];
        snprintf(mac, sizeof(mac), "%02x:%02x:%02x:%02x:%02x:%02x",
                 ai->Address[0], ai->Address[1], ai->Address[2],
                 ai->Address[3], ai->Address[4], ai->Address[5]);
        return mac;
    }
    return "unknown_mac";
}

#else // macOS placeholder

std::string HardwareFingerprint::getCpuId()            { return "apple_cpu"; }
std::string HardwareFingerprint::getMotherboardSerial() { return "apple_board"; }
std::string HardwareFingerprint::getMacAddress()       { return "apple_mac"; }

#endif

std::string HardwareFingerprint::sha256Hex(const std::string& input) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(input.c_str()), input.size(), hash);
    char hex[SHA256_DIGEST_LENGTH * 2 + 1];
    for (int i = 0; i < SHA256_DIGEST_LENGTH; ++i)
        snprintf(hex + i * 2, 3, "%02x", hash[i]);
    return std::string(hex, SHA256_DIGEST_LENGTH * 2);
}

std::string HardwareFingerprint::generate() {
    std::string cpu    = getCpuId();
    std::string board  = getMotherboardSerial();
    std::string mac    = getMacAddress();

    std::string combined = cpu + "|" + board + "|" + mac;
    std::string fingerprint = sha256Hex(combined);

    spdlog::debug("[HardwareFingerprint] cpu={} board={} mac={} -> {}",
                  cpu, board, mac, fingerprint.substr(0, 16) + "...");
    return fingerprint;
}

} // namespace pos::security


// =============================================================================
// main.cpp — Application entry point
// =============================================================================
// #include "core/Application.hpp"

/*
 * Standalone Application class header summary:
 *   class Application {
 *   public:
 *       Application();
 *       int run();
 *   private:
 *       std::unique_ptr<db::LocalDB>         db_;
 *       std::unique_ptr<net::CloudApiClient> api_;
 *       std::unique_ptr<core::HandshakeTimeBomb> timeBomb_;
 *       std::unique_ptr<core::SyncEngine>    syncEngine_;
 *       std::unique_ptr<modules::CheckoutModule> checkout_;
 *       // ... other modules
 *       void initializeDatabase();
 *       void startSyncEngine();
 *       void runUiLoop();    // Dear ImGui main loop
 *   };
 */

#include "db/LocalDB.hpp"
#include "net/CloudApiClient.hpp"
#include "core/HandshakeTimeBomb.hpp"
#include "core/SyncEngine.hpp"
#include "modules/checkout/CheckoutModule.hpp"
#include "security/HardwareFingerprint.hpp"
#include <spdlog/spdlog.h>
#include <spdlog/sinks/rotating_file_sink.h>
#include <iostream>
#include <memory>
#include <fstream>
#include <GLFW/glfw3.h>
#include "imgui.h"
#include "imgui_impl_glfw.h"
#include "imgui_impl_opengl3.h"

// Embedded local schema SQL (compiled in from file at build time via CMake)
extern const char* LOCAL_SCHEMA_SQL;

int main(int argc, char** argv) {
    // -------------------------------------------------------------------------
    // 1. Initialize logger (rotating file + console)
    // -------------------------------------------------------------------------
    auto fileSink = std::make_shared<spdlog::sinks::rotating_file_sink_mt>(
        "pos_client.log", 5 * 1024 * 1024 /*5MB*/, 3 /*keep 3 rotations*/);
    auto consoleSink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
    auto logger = std::make_shared<spdlog::logger>("pos",
        spdlog::sinks_init_list{fileSink, consoleSink});
    spdlog::set_default_logger(logger);
    spdlog::set_level(spdlog::level::info);
    spdlog::info("POS Client starting up");

    try {
        // -------------------------------------------------------------------------
        // 2. Load configuration (cloud_url, terminal_id, etc.)
        // -------------------------------------------------------------------------
        const std::string DB_PATH     = "pos_local.db";
        const std::string CLOUD_URL   = std::getenv("POS_CLOUD_URL")   ?: "https://api.yourdomain.com";
        const std::string HMAC_SECRET = std::getenv("POS_HMAC_SECRET") ?: "";
        const std::string HS_SECRET   = std::getenv("POS_HS_SECRET")   ?: "";

        if (HMAC_SECRET.empty() || HS_SECRET.empty()) {
            spdlog::critical("POS_HMAC_SECRET and POS_HS_SECRET must be set");
            return 1;
        }

        // -------------------------------------------------------------------------
        // 3. Open encrypted local database
        // -------------------------------------------------------------------------
        auto db = std::make_unique<pos::db::LocalDB>(DB_PATH);
        db->open();

        // Apply schema (idempotent — uses CREATE TABLE IF NOT EXISTS)
        db->applySchema(LOCAL_SCHEMA_SQL);
        spdlog::info("Local database initialized");

        // -------------------------------------------------------------------------
        // 4. Initialize cloud API client
        // -------------------------------------------------------------------------
        auto api = std::make_unique<pos::net::CloudApiClient>(CLOUD_URL, HMAC_SECRET);

        // Restore JWT from local config if present
        auto token = db->getConfig("jwt_token");
        if (token) api->setAccessToken(*token);

        // -------------------------------------------------------------------------
        // 5. Initialize HandshakeTimeBomb
        // -------------------------------------------------------------------------
        auto timeBomb = std::make_unique<pos::core::HandshakeTimeBomb>(*db, HS_SECRET);

        // Evaluate offline state before network is available
        auto initialLevel = timeBomb->evaluate();
        spdlog::info("Initial access level: {}", static_cast<int>(initialLevel));

        if (initialLevel == pos::core::AccessLevel::FullyLocked) {
            spdlog::critical("Terminal is fully locked: {}", timeBomb->getRestrictionMessage());
            // Show locked screen in UI and exit or continue in limited mode
        }

        // -------------------------------------------------------------------------
        // 6. Initialize modules
        // -------------------------------------------------------------------------
        auto checkoutModule = std::make_unique<pos::modules::CheckoutModule>(*db, *timeBomb);

        // -------------------------------------------------------------------------
        // 7. Start sync engine (background thread)
        // -------------------------------------------------------------------------
        pos::core::SyncConfig syncCfg;
        syncCfg.syncIntervalSeconds = 30;
        syncCfg.maxBatchSize        = 25;

        auto syncEngine = std::make_unique<pos::core::SyncEngine>(
            *db, *api, *timeBomb, syncCfg);

        syncEngine->setSyncCompleteCallback([](int uploaded, bool online) {
            spdlog::info("[Sync] Complete: {} uploaded, online={}", uploaded, online);
        });

        syncEngine->start();

        // -------------------------------------------------------------------------
        // 8. Run UI loop (Dear ImGui — placeholder for full UI implementation)
        // -------------------------------------------------------------------------
        spdlog::info("Starting UI loop (Dear ImGui)");
        
        if (!glfwInit()) {
            spdlog::critical("Failed to initialize GLFW");
            return 1;
        }

        glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
        glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);

        GLFWwindow* window = glfwCreateWindow(1280, 720, "POS Platform", NULL, NULL);
        if (window == NULL) {
            spdlog::critical("Failed to create GLFW window");
            glfwTerminate();
            return 1;
        }
        glfwMakeContextCurrent(window);
        glfwSwapInterval(1); // Enable vsync

        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGuiIO& io = ImGui::GetIO(); (void)io;
        io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

        ImGui::StyleColorsDark();

        ImGui_ImplGlfw_InitForOpenGL(window, true);
        ImGui_ImplOpenGL3_Init("#version 330");

        // ui::MainWindow mainWindow(*db, *checkoutModule, *syncEngine, *timeBomb);
        // mainWindow.run(window); // Blocks until window is closed

        // For demonstration: run one sync cycle and exit
        syncEngine->triggerImmediateSync();
        std::this_thread::sleep_for(std::chrono::seconds(2));

        // -------------------------------------------------------------------------
        // 9. Cleanup
        // -------------------------------------------------------------------------
        syncEngine->stop();
        db->close();
        spdlog::info("POS Client shut down cleanly");
        return 0;

    } catch (const std::exception& e) {
        spdlog::critical("Fatal error: {}", e.what());
        return 1;
    }
}
