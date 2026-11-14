"use strict";

const session = require("express-session");
const db = require("./db");
const redis = require("./redis");

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

  _sqliteGet(sid) {
    const row = db.prepare("SELECT data FROM sessions WHERE sid=? AND expires_at>?").get(sid, Date.now());
    return row ? JSON.parse(row.data) : null;
  }

  get(sid, callback) {
    (async () => {
      if (redis.client) {
        try {
          const value = await redis.client.get(this.prefix + sid);
          if (value !== null) return JSON.parse(value);
        } catch (_) {
          // Redis is optioneel; lees de persistente SQLite-fallback.
        }
      }
      const value = this._sqliteGet(sid);
      if (value && redis.client) {
        const ttl = Math.max(1, this._expires(value) - Date.now());
        try { await redis.client.set(this.prefix + sid, JSON.stringify(value), "PX", ttl); } catch (_) {}
      }
      return value;
    })().then(value => callback(null, value)).catch(callback);
  }

  set(sid, sess, callback) {
    (async () => {
      const expiresAt = this._expires(sess);
      const ttl = Math.max(1, expiresAt - Date.now());
      db.prepare(
        "INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) " +
        "ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at"
      ).run(sid, JSON.stringify(sess), expiresAt);
      if (redis.client) {
        try { await redis.client.set(this.prefix + sid, JSON.stringify(sess), "PX", ttl); }
        catch (_) { /* SQLite blijft de persistente bron zolang de MySQL-migratie niet is afgerond. */ }
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  destroy(sid, callback) {
    (async () => {
      db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);
      if (redis.client) {
        try { await redis.client.del(this.prefix + sid); } catch (_) {}
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  touch(sid, sess, callback) {
    (async () => {
      const expiresAt = this._expires(sess);
      db.prepare("UPDATE sessions SET expires_at=? WHERE sid=?").run(expiresAt, sid);
      if (redis.client) {
        try { await redis.client.pexpire(this.prefix + sid, Math.max(1, expiresAt - Date.now())); }
        catch (_) { /* SQLite blijft de persistente bron zolang de MySQL-migratie niet is afgerond. */ }
      }
    })().then(() => callback && callback(null)).catch(error => callback && callback(error));
  }

  async close() {
    // The shared Redis client is closed by the application shutdown handler.
  }
}

module.exports = PersistentSessionStore;
