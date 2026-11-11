const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

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
db.exec("DROP TABLE IF EXISTS magic_login_tokens");
const userCols = db.prepare("PRAGMA table_info(users)").all().map(x => x.name);
if (!userCols.includes("active")) db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");

const insertAdmin = db.prepare(`INSERT INTO users (name,email,password_hash,role,active)
 VALUES ('Bendemen Admin','info@bendemen.nl','password-not-set','admin',1)
 ON CONFLICT(email) DO UPDATE SET role='admin',active=1`);
insertAdmin.run();

// Stel het adminwachtwoord rechtstreeks in via ADMIN_PASSWORD in .env.
// Het wachtwoord wordt alleen als bcrypt-hash in SQLite opgeslagen.
if (process.env.ADMIN_PASSWORD) {
  if (process.env.ADMIN_PASSWORD.length < 12) {
    throw new Error("ADMIN_PASSWORD moet minimaal 12 tekens bevatten.");
  }
  const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
  db.prepare("UPDATE users SET password_hash=? WHERE email=? COLLATE NOCASE AND role='admin'")
    .run(adminHash, "info@bendemen.nl");
}

module.exports = db;
