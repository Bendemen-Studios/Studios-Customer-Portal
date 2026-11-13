const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const dbPath = process.env.DB_PATH || "./data/bendemen.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("temp_store = MEMORY");
db.pragma("cache_size = -20000"); // circa 20 MB SQLite page cache
db.pragma("mmap_size = 268435456"); // maximaal 256 MB memory-mapped database
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'customer',
 active INTEGER NOT NULL DEFAULT 1,
 wc_customer_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'Nieuw',
 total_cents INTEGER NOT NULL DEFAULT 0,
 source_order_id INTEGER,
 notes TEXT,
 recurring_order_id INTEGER,
 workflow_status TEXT DEFAULT 'started',
 wc_order_id TEXT,
 wc_status TEXT,
 payment_url TEXT,
 currency TEXT NOT NULL DEFAULT 'EUR',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 wc_product_id TEXT UNIQUE,
 name TEXT NOT NULL,
 sku TEXT,
 description TEXT,
 price_cents INTEGER NOT NULL DEFAULT 0,
 cost_cents INTEGER NOT NULL DEFAULT 0,
 product_url TEXT,
 image_url TEXT,
 source TEXT NOT NULL DEFAULT 'manual',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 product_id TEXT,
 product_name TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 1,
 unit_price_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recurring_orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL DEFAULT 'Abonnement',
 status TEXT NOT NULL DEFAULT 'active',
 amount_cents INTEGER NOT NULL DEFAULT 0,
 currency TEXT NOT NULL DEFAULT 'EUR',
 interval TEXT NOT NULL DEFAULT 'month',
 next_payment TEXT,
 wc_subscription_id TEXT,
 notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS recurring_order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 recurring_order_id INTEGER NOT NULL REFERENCES recurring_orders(id) ON DELETE CASCADE,
 product_id TEXT,
 product_name TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 1,
 unit_price_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS monthly_costs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 amount_cents INTEGER NOT NULL,
 interval TEXT NOT NULL DEFAULT 'month',
 active INTEGER NOT NULL DEFAULT 1,
 wc_order_id TEXT,
 notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 amount_cents INTEGER NOT NULL,
 expense_date TEXT NOT NULL DEFAULT (date('now')),
 product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
 wc_order_id TEXT,
 notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_cache (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 wc_order_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,wc_order_id)
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS cancellations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 order_id TEXT NOT NULL,
 reason TEXT,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function addColumn(table, column, definition) {
 const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
 if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
addColumn("recurring_orders", "last_generated_for", "TEXT");
addColumn("recurring_orders", "manual_generation_token", "TEXT");
addColumn("products", "cost_cents", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "wc_customer_id", "TEXT");
db.exec("UPDATE users SET active=0 WHERE role='customer' AND wc_customer_id IS NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wc_customer ON users(wc_customer_id) WHERE wc_customer_id IS NOT NULL");
addColumn("orders", "workflow_status", "TEXT DEFAULT 'started'");
addColumn("orders", "wc_order_id", "TEXT");
addColumn("orders", "wc_status", "TEXT");
addColumn("orders", "payment_url", "TEXT");
addColumn("orders", "currency", "TEXT NOT NULL DEFAULT 'EUR'");
addColumn("orders", "source_order_id", "INTEGER");
addColumn("orders", "notes", "TEXT");
addColumn("orders", "recurring_order_id", "INTEGER");
addColumn("orders", "allow_reorder", "INTEGER NOT NULL DEFAULT 1");
addColumn("orders", "show_in_history", "INTEGER NOT NULL DEFAULT 0");
db.exec("UPDATE orders SET show_in_history=1 WHERE allow_reorder=0 AND notes LIKE 'Handmatig toegevoegd door beheer%'");
addColumn("monthly_costs", "interval", "TEXT NOT NULL DEFAULT 'month'");
addColumn("monthly_costs", "wc_order_id", "TEXT");
addColumn("monthly_costs", "notes", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC); CREATE INDEX IF NOT EXISTS idx_orders_history ON orders(user_id, show_in_history, id DESC); CREATE INDEX IF NOT EXISTS idx_products_active ON products(active); CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_orders(user_id); CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_orders(status, next_payment); CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);");

db.exec("DROP TABLE IF EXISTS magic_login_tokens");
const insertAdmin = db.prepare(`INSERT INTO users (name,email,password_hash,role,active)
 VALUES ('Bendemen Admin','info@bendemen.nl','password-not-set','admin',1)
 ON CONFLICT(email) DO UPDATE SET role='admin',active=1`);
insertAdmin.run();

if (process.env.ADMIN_PASSWORD) {
 if (process.env.ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD moet minimaal 12 tekens bevatten.");
 const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
 db.prepare("UPDATE users SET password_hash=? WHERE email=? COLLATE NOCASE AND role='admin'").run(adminHash, "info@bendemen.nl");
}

module.exports = db;
