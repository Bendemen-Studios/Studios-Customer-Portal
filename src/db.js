const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const dbPath = process.env.DB_PATH || "./data/bendemen.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'customer',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS magic_login_tokens (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_user ON magic_login_tokens(user_id, expires_at);
CREATE TABLE IF NOT EXISTS order_cache (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 wc_order_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,wc_order_id)
);
CREATE TABLE IF NOT EXISTS cancellations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 order_id TEXT NOT NULL,
 reason TEXT,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const userCols = db.prepare("PRAGMA table_info(users)").all().map(x => x.name);
if (!userCols.includes("active")) db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");

const insertAdmin = db.prepare(`INSERT INTO users (name,email,password_hash,role,active)
 VALUES ('Bendemen Admin','info@bendemen.nl','magic-link-only','admin',1)
 ON CONFLICT(email) DO UPDATE SET role='admin',active=1`);
insertAdmin.run();

module.exports = db;
