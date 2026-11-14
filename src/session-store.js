"use strict";

const session = require("express-session");
const db = require("./db");
const redis = require("./redis");

const driver = String(process.env.SESSION_STORE_DRIVER || "sqlite").toLowerCase();
if (!["sqlite", "mysql"].includes(driver)) {
  throw new Error("SESSION_STORE_DRIVER moet 'sqlite' of 'mysql' zijn.");
}

let mysqlPool = null;
let mysqlReady = null;
if (driver === "mysql") {
  const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error("MySQL-sessies ingeschakeld, maar configuratie ontbreekt: " + missing.join(", "));
  }
  const mysql = require("mysql2/promise");
  mysqlPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: Math.max(2, Number(process.env.DB_CONNECTION_LIMIT || 10)),
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true
  });
  mysqlReady = null;
}

async function ensureMysqlReady() {
  if (!mysqlReady) {
    mysqlReady = mysqlPool.query(
      "CREATE TABLE IF NOT EXISTS sessions (" +
      "sid VARCHAR(255) NOT NULL PRIMARY KEY," +
      "data LONGTEXT NOT NULL," +
      "expires_at BIGINT NOT NULL," +
      "KEY idx_sessions_expiry (expires_at)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    ).then(() => true).catch(error => {
      mysqlReady = null;
      throw error;
    });
  }
  await ensureMysqlReady();
}

class PersistentSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.prefix = options.prefix || process.env.REDIS_SESSION_PREFIX || "bendemen:supply-panel:sess:";
  }

  _expires(sess) {
    const value = sess && sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 8 * 60 * 60 * 1000;
    return Number.isFinite(value) ? value : Date.now() + 8 * 60 * 60 * 1000;
  }

  async _persistentGet(sid) {
    if (driver === "mysql") {
      await ensureMysqlReady();
      const [rows] = await mysqlPool.execute(
        "SELECT data FROM sessions WHERE sid=? AND expires_at>?",
        [sid, Date.now()]
      );
      return rows.length ? JSON.parse(rows[0].data) : null;
    }
    const row = db.prepare("SELECT data FROM sessions WHERE sid=? AND expires_at>?").get(sid, Date.now());
    return row ? JSON.parse(row.data) : null;
  }

  async _persistentSet(sid, sess, expiresAt) {
    if (driver === "mysql") {
      await ensureMysqlReady();
      await mysqlPool.execute(
        "INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) " +
        "ON DUPLICATE KEY UPDATE data=VALUES(data),expires_at=VALUES(expires_at)",
        [sid, JSON.stringify(sess), expiresAt]
      );
      return;
    }
    db.prepare(
      "INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) " +
      "ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at"
    ).run(sid, JSON.stringify(sess), expiresAt);
  }

  async _persistentDelete(sid) {
    if (driver === "mysql") {
      await ensureMysqlReady();
      await mysqlPool.execute("DELETE FROM sessions WHERE sid=?", [sid]);
      return;
    }
    db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);
  }

  async _persistentTouch(sid, expiresAt) {
    if (driver === "mysql") {
      await ensureMysqlReady();
      await mysqlPool.execute("UPDATE sessions SET expires_at=? WHERE sid=?", [expiresAt, sid]);
      return;
    }
    db.prepare("UPDATE sessions SET expires_at=? WHERE sid=?").run(expiresAt, sid);
  }

  get(sid, callback) {
    (async () => {
      if (redis.client) {
        try {
          const value = await redis.client.get(this.prefix + sid);
          if (value !== null) return JSON.parse(value);
        } catch (_) {
          // Redis is een cache; de persistente database blijft beschikbaar.
        }
      }
      const value = await this._persistentGet(sid);
      if (value && redis.client) {
        const ttl = Math.max(1, this._expires(value) - Date.now());
        try { await redis.client.set(this.prefix + sid, JSON.stringify(value), "PX", ttl); } catch (_) {}
      }
      return value;
    })().then(value => callback(null, value)).catch(error => callback(error));
  }

  set(sid, sess, callback) {
    (async () => {
      const expiresAt = this._expires(sess);
      const ttl = Math.max(1, expiresAt - Date.now());
      await this._persistentSet(sid, sess, expiresAt);
      if (redis.client) {
        try { await redis.client.set(this.prefix + sid, JSON.stringify(sess), "PX", ttl); }
        catch (_) { /* Database persistence is authoritative. */ }
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  destroy(sid, callback) {
    (async () => {
      await this._persistentDelete(sid);
      if (redis.client) {
        try { await redis.client.del(this.prefix + sid); } catch (_) {}
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  touch(sid, sess, callback) {
    (async () => {
      const expiresAt = this._expires(sess);
      await this._persistentTouch(sid, expiresAt);
      if (redis.client) {
        try { await redis.client.pexpire(this.prefix + sid, Math.max(1, expiresAt - Date.now())); }
        catch (_) { /* Database persistence is authoritative. */ }
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  async close() {
    if (mysqlPool) await mysqlPool.end();
  }
}

module.exports = PersistentSessionStore;
