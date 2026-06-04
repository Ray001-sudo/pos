cmake_minimum_required(VERSION 3.20)
project(POSClient VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ============================================================
# Compiler hardening flags
# ============================================================
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(
        -Wall -Wextra -Wpedantic
        -fstack-protector-strong
        -D_FORTIFY_SOURCE=2
        -fPIE
        -fno-exceptions          # Remove if you prefer exceptions
    )
    add_link_options(-pie -Wl,-z,relro,-z,now)
endif()

# Release: strip symbols, optimize
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    add_compile_options(-O2 -DNDEBUG)
    add_link_options(-s)
endif()

# ============================================================
# Dependencies (via vcpkg or system packages)
# ============================================================
find_package(SQLite3   REQUIRED)
find_package(CURL      REQUIRED)
find_package(OpenSSL   REQUIRED)
find_package(nlohmann_json 3.11 REQUIRED)
find_package(spdlog    REQUIRED)
find_package(fmt       REQUIRED)
find_package(imgui     REQUIRED)     # Dear ImGui for UI
find_package(glfw3     REQUIRED)     # Window/Input (for ImGui backend)
find_package(OpenGL    REQUIRED)

# SQLCipher: link as system lib (apt: libsqlcipher-dev)
find_library(SQLCIPHER_LIB sqlcipher REQUIRED)

# ============================================================
# Source files
# ============================================================
set(SOURCES
    src/main.cpp
    src/core/Application.cpp
    src/core/Config.cpp
    src/core/LicenseManager.cpp
    src/core/SyncEngine.cpp
    src/core/HandshakeTimeBomb.cpp
    src/db/LocalDB.cpp
    src/db/ProductCache.cpp
    src/modules/checkout/CheckoutModule.cpp
    src/modules/checkout/CartManager.cpp
    src/modules/checkout/ReceiptPrinter.cpp
    src/modules/inventory/InventoryModule.cpp
    src/modules/restaurant/RestaurantModule.cpp
    src/modules/restaurant/KitchenOrderTicket.cpp
    src/modules/membership/MembershipModule.cpp
    src/modules/pharmacy/PharmacyModule.cpp
    src/modules/reports/ReportsModule.cpp
    src/modules/auth/AuthModule.cpp
    src/net/HttpClient.cpp
    src/net/CloudApiClient.cpp
    src/ui/MainWindow.cpp
    src/ui/CheckoutView.cpp
    src/ui/InventoryView.cpp
    src/ui/ReportsView.cpp
    src/ui/RestaurantView.cpp
    src/ui/SettingsView.cpp
    src/security/Crypto.cpp
    src/security/HardwareFingerprint.cpp
)

add_executable(pos_client ${SOURCES})

# ============================================================
# Include paths
# ============================================================
target_include_directories(pos_client PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${SQLite3_INCLUDE_DIRS}
    ${CURL_INCLUDE_DIRS}
    ${OPENSSL_INCLUDE_DIR}
)

# ============================================================
# Link libraries
# ============================================================
target_link_libraries(pos_client PRIVATE
    ${SQLCIPHER_LIB}
    CURL::libcurl
    OpenSSL::SSL
    OpenSSL::Crypto
    nlohmann_json::nlohmann_json
    spdlog::spdlog
    fmt::fmt
    imgui::imgui
    glfw
    OpenGL::GL
    pthread
    dl
)

# ============================================================
# Windows-specific: link winsock for networking
# ============================================================
if(WIN32)
    target_link_libraries(pos_client PRIVATE ws2_32 crypt32)
endif()

# ============================================================
# Install targets
# ============================================================
install(TARGETS pos_client DESTINATION bin)
install(DIRECTORY ${CMAKE_SOURCE_DIR}/assets DESTINATION share/pos_client)
