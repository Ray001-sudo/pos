// =============================================================================
// CheckoutModule.hpp/.cpp
// Checkout flow: barcode scan → cart → payment → receipt
// Fully offline-capable; transactions queued locally for sync
// =============================================================================
#pragma once

#include <string>
#include <vector>
#include <optional>
#include <functional>
#include <nlohmann/json.hpp>
#include "db/LocalDB.hpp"
#include "core/HandshakeTimeBomb.hpp"
#include <spdlog/spdlog.h>

namespace pos::modules {

using json = nlohmann::json;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------
struct CartItem {
    std::string product_id;
    std::string name;
    double      unit_price;
    int         quantity;
    double      line_total;
    double      tax_rate;
};

struct PaymentSplit {
    double cashAmount        = 0.0;
    double cardAmount        = 0.0;
    double mobileMoney       = 0.0;
};

enum class PaymentMethod { Cash, Card, MobileMoney, Split };

struct CheckoutResult {
    bool        success;
    std::string receipt_id;
    std::string errorMessage;
};

// ---------------------------------------------------------------------------
// CartManager — manages current cart state (in-memory)
// ---------------------------------------------------------------------------
class CartManager {
public:
    CartManager() = default;

    // Add product to cart (by product_id lookup in local DB)
    bool addItem(db::LocalDB& db, const std::string& productId, int quantity = 1);

    // Add by barcode scan
    bool addByBarcode(db::LocalDB& db, const std::string& barcode, int quantity = 1);

    // Update quantity for existing cart line
    bool updateQuantity(const std::string& productId, int newQuantity);

    // Remove item
    void removeItem(const std::string& productId);

    // Clear entire cart
    void clear();

    // Apply percentage discount (0-100) to entire cart
    void applyDiscount(double discountPercent, double maxAllowed = 100.0);

    // Getters
    const std::vector<CartItem>& items() const { return items_; }
    double subtotal()       const;
    double taxTotal()       const;
    double discountTotal()  const;
    double grandTotal()     const;
    int    itemCount()      const;
    bool   isEmpty()        const { return items_.empty(); }

    // For serialization into JSON for local DB storage
    json toJson() const;

private:
    std::vector<CartItem> items_;
    double discountPercent_ = 0.0;
};

// ---------------------------------------------------------------------------
// CheckoutModule — drives the complete checkout workflow
// ---------------------------------------------------------------------------
class CheckoutModule {
public:
    CheckoutModule(db::LocalDB& db, HandshakeTimeBomb& timeBomb);

    // Process checkout: persist transaction locally, return receipt_id
    // Called when cashier hits "Charge" button
    CheckoutResult processCheckout(
        const CartManager&     cart,
        PaymentMethod          method,
        const std::string&     cashierId,
        const PaymentSplit&    split = {},
        const std::string&     customerId = ""   // optional loyalty
    );

    // Void a previously saved transaction (requires manager role verification upstream)
    bool voidTransaction(const std::string& receiptId, const std::string& voidReason);

    // Lookup a product by barcode (from local cache)
    std::optional<json> lookupByBarcode(const std::string& barcode);

    // Get recent receipts (last N)
    std::vector<json> getRecentReceipts(int limit = 20);

    // Format receipt as printable string
    std::string formatReceiptText(const std::string& receiptId);

private:
    db::LocalDB&        db_;
    HandshakeTimeBomb&  timeBomb_;

    std::string generateReceiptId();
    void        saveTransaction(const std::string& receiptId,
                                const CartManager& cart,
                                PaymentMethod      method,
                                const std::string& cashierId,
                                const PaymentSplit& split);
    std::string paymentMethodToString(PaymentMethod m);
};

// =============================================================================
// CartManager Implementation
// =============================================================================

bool CartManager::addItem(db::LocalDB& db, const std::string& productId, int quantity) {
    auto rows = db.queryRows(
        "SELECT p.product_id, p.name, p.price, COALESCE(tr.percentage, p.tax_rate) as tax_rate, p.stock_quantity, p.is_active "
        "FROM local_products p "
        "LEFT JOIN local_tax_rates tr ON p.tax_group_id = tr.group_id "
        "WHERE p.product_id = ? AND p.is_active = '1';",
        {productId}
    );
    if (rows.empty()) return false;

    auto& row = rows[0];
    std::string name; double price = 0.0, taxRate = 0.0; int stock = 0;
    for (auto& [k, v] : row) {
        if (k == "name")           name    = v;
        else if (k == "price")     price   = std::stod(v);
        else if (k == "tax_rate")  taxRate = std::stod(v);
        else if (k == "stock_quantity") stock = std::stoi(v);
    }

    if (stock < quantity) {
        spdlog::warn("[Cart] Insufficient stock for {} (have {}, want {})", productId, stock, quantity);
        return false;
    }

    // Check if already in cart
    for (auto& item : items_) {
        if (item.product_id == productId) {
            item.quantity  += quantity;
            item.line_total = item.unit_price * item.quantity;
            return true;
        }
    }

    CartItem item;
    item.product_id = productId;
    item.name       = name;
    item.unit_price = price;
    item.quantity   = quantity;
    item.line_total = price * quantity;
    item.tax_rate   = taxRate;
    items_.push_back(item);
    return true;
}

bool CartManager::addByBarcode(db::LocalDB& db, const std::string& barcode, int quantity) {
    auto rows = db.queryRows(
        "SELECT product_id FROM local_products WHERE barcode = ? AND is_active = '1' LIMIT 1;",
        {barcode}
    );
    if (rows.empty()) return false;

    std::string productId;
    for (auto& [k, v] : rows[0])
        if (k == "product_id") productId = v;

    return addItem(db, productId, quantity);
}

bool CartManager::updateQuantity(const std::string& productId, int newQuantity) {
    for (auto& item : items_) {
        if (item.product_id == productId) {
            if (newQuantity <= 0) {
                removeItem(productId);
            } else {
                item.quantity   = newQuantity;
                item.line_total = item.unit_price * newQuantity;
            }
            return true;
        }
    }
    return false;
}

void CartManager::removeItem(const std::string& productId) {
    items_.erase(
        std::remove_if(items_.begin(), items_.end(),
            [&](const CartItem& i) { return i.product_id == productId; }),
        items_.end()
    );
}

void CartManager::clear() {
    items_.clear();
    discountPercent_ = 0.0;
}

void CartManager::applyDiscount(double discountPercent, double maxAllowed) {
    discountPercent_ = std::max(0.0, std::min(maxAllowed, discountPercent));
}

double CartManager::subtotal() const {
    double s = 0.0;
    for (auto& i : items_) s += i.line_total;
    return s;
}

double CartManager::taxTotal() const {
    double t = 0.0;
    for (auto& i : items_) t += i.line_total * (i.tax_rate / 100.0);
    return t;
}

double CartManager::discountTotal() const {
    return subtotal() * (discountPercent_ / 100.0);
}

double CartManager::grandTotal() const {
    return subtotal() + taxTotal() - discountTotal();
}

int CartManager::itemCount() const {
    int cnt = 0;
    for (auto& i : items_) cnt += i.quantity;
    return cnt;
}

json CartManager::toJson() const {
    json arr = json::array();
    for (auto& item : items_) {
        arr.push_back({
            {"product_id", item.product_id},
            {"name",       item.name},
            {"unit_price", item.unit_price},
            {"quantity",   item.quantity},
            {"line_total", item.line_total},
            {"tax_rate",   item.tax_rate}
        });
    }
    return arr;
}

// =============================================================================
// CheckoutModule Implementation
// =============================================================================

CheckoutModule::CheckoutModule(db::LocalDB& db, HandshakeTimeBomb& timeBomb)
    : db_(db), timeBomb_(timeBomb) {}

CheckoutResult CheckoutModule::processCheckout(
    const CartManager&  cart,
    PaymentMethod       method,
    const std::string&  cashierId,
    const PaymentSplit& split,
    const std::string&  customerId)
{
    // --- Access level check ---
    AccessLevel level = timeBomb_.evaluate();
    if (level == AccessLevel::ReadOnly ||
        level == AccessLevel::CheckoutBlocked ||
        level == AccessLevel::FullyLocked) {
        return {false, "", timeBomb_.getRestrictionMessage()};
    }

    if (cart.isEmpty()) {
        return {false, "", "Cart is empty"};
    }

    std::string receiptId = generateReceiptId();

    try {
        saveTransaction(receiptId, cart, method, cashierId, split);
        spdlog::info("[Checkout] Transaction saved: {}", receiptId);
        return {true, receiptId, ""};
    } catch (const std::exception& e) {
        spdlog::error("[Checkout] Failed to save transaction: {}", e.what());
        return {false, "", "Failed to save transaction: " + std::string(e.what())};
    }
}

void CheckoutModule::saveTransaction(const std::string& receiptId,
                                     const CartManager& cart,
                                     PaymentMethod      method,
                                     const std::string& cashierId,
                                     const PaymentSplit& split) {
    auto now = std::chrono::system_clock::now();
    auto tt  = std::chrono::system_clock::to_time_t(now);
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&tt));

    std::string itemsJson = cart.toJson().dump();
    std::string pmStr     = paymentMethodToString(method);

    db_.execute(
        "INSERT INTO local_transactions "
        "(receipt_id, cashier_id, subtotal, tax_total, discount_total, grand_total, "
        " payment_method, sale_timestamp, is_voided, is_synced, sync_attempts, items_json) "
        "VALUES (?,?,?,?,?,?,?,?,0,0,0,?);",
        {
            receiptId,
            cashierId,
            std::to_string(cart.subtotal()),
            std::to_string(cart.taxTotal()),
            std::to_string(cart.discountTotal()),
            std::to_string(cart.grandTotal()),
            pmStr,
            std::string(buf),
            itemsJson
        }
    );
}

bool CheckoutModule::voidTransaction(const std::string& receiptId, const std::string& reason) {
    db_.execute(
        "UPDATE local_transactions SET is_voided = 1, void_reason = ?, is_synced = 0 "
        "WHERE receipt_id = ? AND is_voided = 0;",
        {reason, receiptId}
    );
    return true;
}

std::optional<json> CheckoutModule::lookupByBarcode(const std::string& barcode) {
    auto rows = db_.queryRows(
        "SELECT product_id, name, price, tax_rate, stock_quantity, unit, category "
        "FROM local_products WHERE barcode = ? AND is_active = '1' LIMIT 1;",
        {barcode}
    );
    if (rows.empty()) return std::nullopt;

    json product;
    for (auto& [k, v] : rows[0]) product[k] = v;
    return product;
}

std::vector<json> CheckoutModule::getRecentReceipts(int limit) {
    auto rows = db_.queryRows(
        "SELECT receipt_id, cashier_id, grand_total, payment_method, sale_timestamp, is_voided "
        "FROM local_transactions ORDER BY sale_timestamp DESC LIMIT ?;",
        {std::to_string(limit)}
    );

    std::vector<json> receipts;
    for (auto& row : rows) {
        json r;
        for (auto& [k, v] : row) r[k] = v;
        receipts.push_back(r);
    }
    return receipts;
}

std::string CheckoutModule::generateReceiptId() {
    // UUID v4 — use OpenSSL RAND_bytes for cryptographically random UUID
    unsigned char bytes[16];
    RAND_bytes(bytes, sizeof(bytes));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant bits

    char uuid[37];
    snprintf(uuid, sizeof(uuid),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2],  bytes[3],
        bytes[4], bytes[5], bytes[6],  bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12],bytes[13],bytes[14], bytes[15]);

    return std::string(uuid);
}

std::string CheckoutModule::paymentMethodToString(PaymentMethod m) {
    switch (m) {
        case PaymentMethod::Cash:        return "cash";
        case PaymentMethod::Card:        return "card";
        case PaymentMethod::MobileMoney: return "mobile_money";
        case PaymentMethod::Split:       return "split";
        default:                         return "cash";
    }
}

std::string CheckoutModule::formatReceiptText(const std::string& receiptId) {
    auto rows = db_.queryRows(
        "SELECT receipt_id, cashier_id, subtotal, tax_total, discount_total, "
        "       grand_total, payment_method, sale_timestamp, items_json "
        "FROM local_transactions WHERE receipt_id = ?;",
        {receiptId}
    );
    if (rows.empty()) return "Receipt not found";

    std::string subtotal, taxTotal, discountTotal, grandTotal, pmStr, timestamp, itemsJsonStr;
    for (auto& [k, v] : rows[0]) {
        if      (k == "subtotal")       subtotal        = v;
        else if (k == "tax_total")      taxTotal        = v;
        else if (k == "discount_total") discountTotal   = v;
        else if (k == "grand_total")    grandTotal      = v;
        else if (k == "payment_method") pmStr           = v;
        else if (k == "sale_timestamp") timestamp       = v;
        else if (k == "items_json")     itemsJsonStr    = v;
    }

    auto items = json::parse(itemsJsonStr);
    std::string out;
    out += "================================\n";
    out += "         SALES RECEIPT\n";
    out += "================================\n";
    out += "Date: " + timestamp + "\n";
    out += "--------------------------------\n";
    for (auto& item : items) {
        std::string name  = item.value("name", "");
        int qty           = item.value("quantity", 1);
        double lineTotal  = item.value("line_total", 0.0);
        char line[80];
        snprintf(line, sizeof(line), "%-20s x%-3d %8.2f\n", name.c_str(), qty, lineTotal);
        out += line;
    }
    out += "--------------------------------\n";
    char buf[80];
    snprintf(buf, sizeof(buf), "Subtotal:           %8s\n", subtotal.c_str()); out += buf;
    snprintf(buf, sizeof(buf), "Tax:                %8s\n", taxTotal.c_str()); out += buf;
    if (std::stod(discountTotal) > 0) {
        snprintf(buf, sizeof(buf), "Discount:           %8s\n", discountTotal.c_str()); out += buf;
    }
    out += "================================\n";
    snprintf(buf, sizeof(buf), "TOTAL:              %8s\n", grandTotal.c_str()); out += buf;
    out += "Payment: " + pmStr + "\n";
    out += "================================\n";
    out += "    Thank you for shopping!\n";
    out += "================================\n";
    return out;
}

} // namespace pos::modules
