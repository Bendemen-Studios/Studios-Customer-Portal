"use strict";

const session = require("express-session");
const Redis = require("ioredis");
const mysql = require("./mysql");

class PersistentSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.prefix = options.prefix || process.env.REDIS_SESSION_PREFIX || "bendemen:sess:";
    this.redis = null;

    if (process.env.REDIS_URL) {
      this.redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 5000,
        retryStrategy: attempt => attempt > 3 ? null : Math.min(attempt * 500, 1500)
      });
      this.redis.on("error", error => {
        console.error("Redis-sessieopslag niet beschikbaar; MySQL-fallback wordt gebruikt:", error.message);
      });
      this.redis.connect().catch(() => {});
    }
  }

  _expires(sess) {
    const value = sess && sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 8 * 60 * 60 * 1000;
    return Number.isFinite(value) ? value : Date.now() + 8 * 60 * 60 * 1000;
  }

  async _mysqlGet(sid) {
    const rows = await mysql.query(
      "SELECT data FROM sessions WHERE sid=? AND expires_at>?",
      [sid, Date.now()]
    );
    return rows.length ? JSON.parse(rows[0].data) : null;
  }

  get(sid, callback) {
    (async () => {
      if (this.redis) {
        try {
          const value = await this.redis.get(this.prefix + sid);
          if (value !== null) return JSON.parse(value);
        } catch (_) {
          // Redis is optioneel; val terug op de persistente MySQL-sessies.
        }
      }
      return this._mysqlGet(sid);
    })().then(value => callback(null, value)).catch(callback);
  }

  set(sid, sess, callback) {
    (async () => {
      const expiresAt = this._expires(sess);
      const ttl = Math.max(1, expiresAt - Date.now());
      await mysql.query(
        "INSERT INTO sessions (sid,data,expires_at) VALUES (?,?,?) " +
        "ON DUPLICATE KEY UPDATE data=VALUES(data),expires_at=VALUES(expires_at)",
        [sid, JSON.stringify(sess), expiresAt]
      );
      if (this.redis) {
        try { await this.redis.set(this.prefix + sid, JSON.stringify(sess), "PX", ttl); }
        catch (_) { /* MySQL blijft de persistente bron. */ }
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  destroy(sid, callback) {
    (async () => {
      if (this.redis) {
        try { await this.redis.del(this.prefix + sid); } catch (_) {}
      }
      await mysql.query("DELETE FROM sessions WHERE sid=?", [sid]);
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  touch(sid, sess, callback) {
    (async () => {
      const expiresAt = this._expires(sess);
      await mysql.query("UPDATE sessions SET expires_at=? WHERE sid=?", [expiresAt, sid]);
      if (this.redis) {
        try { await this.redis.pexpire(this.prefix + sid, Math.max(1, expiresAt - Date.now())); }
        catch (_) { /* MySQL blijft beschikbaar als Redis uitvalt. */ }
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  async close() {
    if (this.redis) await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

module.exports = PersistentSessionStore;
