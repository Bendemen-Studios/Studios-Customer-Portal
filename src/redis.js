"use strict";

const Redis = require("ioredis");

const hasUrl = Boolean(process.env.REDIS_URL);
const hasHost = Boolean(process.env.REDIS_HOST);
const enabled = hasUrl || hasHost;
const prefix = process.env.REDIS_CACHE_PREFIX || "bendemen:supply-panel:cache:";

let client = null;
if (enabled) {
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: Math.max(1000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000),
    retryStrategy: attempt => Math.min(500 + attempt * 500, 5000)
  };

  if (hasUrl) {
    client = new Redis(process.env.REDIS_URL, options);
  } else {
    const port = Number(process.env.REDIS_PORT || 6379);
    const db = Number(process.env.REDIS_DB || 0);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("REDIS_PORT moet een geldig poortnummer zijn.");
    }
    if (!Number.isInteger(db) || db < 0) {
      throw new Error("REDIS_DB moet een niet-negatief geheel getal zijn.");
    }
    client = new Redis({
      ...options,
      host: process.env.REDIS_HOST,
      port,
      db,
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === "true" ? {} : undefined
    });
  }

  client.on("error", error => {
    console.error("Redis niet beschikbaar; de applicatie gebruikt de fallback:", error.message);
  });
  client.connect().catch(() => {});
}

function cacheKey(key) {
  return prefix + String(key);
}

async function cacheGet(key) {
  if (!client) return null;
  try {
    const value = await client.get(cacheKey(key));
    return value === null ? null : JSON.parse(value);
  } catch (_) {
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 300) {
  if (!client) return false;
  const ttl = Math.max(1, Math.trunc(Number(ttlSeconds) || 300));
  try {
    await client.set(cacheKey(key), JSON.stringify(value), "EX", ttl);
    return true;
  } catch (_) {
    return false;
  }
}

async function cacheDelete(key) {
  if (!client) return false;
  try {
    await client.del(cacheKey(key));
    return true;
  } catch (_) {
    return false;
  }
}

async function healthCheck() {
  if (!client) return { enabled: false, connected: false };
  try {
    const pong = await client.ping();
    return { enabled: true, connected: pong === "PONG" };
  } catch (_) {
    return { enabled: true, connected: false };
  }
}

async function close() {
  if (!client) return;
  if (client.status === "ready") await client.quit().catch(() => client.disconnect());
  else client.disconnect();
}

module.exports = { client, enabled, cacheGet, cacheSet, cacheDelete, healthCheck, close };
