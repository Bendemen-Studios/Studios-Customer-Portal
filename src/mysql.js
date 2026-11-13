"use strict";

const mysql = require("mysql2/promise");

const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
const missing = required.filter(key => !process.env[key]);

if (missing.length) {
  throw new Error("MySQL-configuratie ontbreekt: " + missing.join(", "));
}

const pool = mysql.createPool({
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
  enableKeepAlive: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  dateStrings: true
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work({
      query: async (sql, params = []) => {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
      execute: (sql, params = []) => connection.execute(sql, params)
    });
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

async function healthCheck() {
  await query("SELECT 1");
  return true;
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, transaction, healthCheck, close };
