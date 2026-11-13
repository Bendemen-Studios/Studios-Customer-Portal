require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const Database = require("better-sqlite3");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("crypto");

const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) throw new Error(key + " ontbreekt in de Pterodactyl environment.");
}

const sqlitePath = path.resolve(process.env.DB_PATH || "./data/bendemen.sqlite");
const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const quote = value => "\`" + String(value).replace(/\`/g, "\`\`") + "\`";

function mysqlType(column, indexedColumns, useAutoIncrement) {
  const name = column.name;
  const type = String(column.type || "").toUpperCase();
  if (column.pk && useAutoIncrement && type.includes("INT")) return "BIGINT NOT NULL AUTO_INCREMENT";
  if (column.pk && !type.includes("INT")) return "VARCHAR(255) NOT NULL";
  if (/INT/.test(type)) return "BIGINT";
  if (/REAL|FLOA|DOUB/.test(type)) return "DOUBLE";
  if (/BLOB/.test(type)) return "LONGBLOB";
  if (/BOOL/.test(type)) return "TINYINT(1)";
  if (["email"].includes(name)) return "VARCHAR(320)";
  if (["sid"].includes(name)) return "VARCHAR(255)";
  if (indexedColumns.has(name) || /(^|_)(id|sku|status|role|interval|currency|source)$/.test(name)) return "VARCHAR(191)";
  if (/(^|_)(date|at)$/.test(name) || name.endsWith("_for") || name.endsWith("_payment")) return "VARCHAR(64)";
  return "LONGTEXT";
}

function safeDefault(value, column) {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  if (/^CURRENT_TIMESTAMP(?:\\(\\))?$/i.test(raw)) return " DEFAULT CURRENT_TIMESTAMP";
  if (/^\\(date\\('now'\\)\\)$/i.test(raw)) return " DEFAULT (CURRENT_DATE)";
  if (/^-?\\d+(?:\\.\\d+)?$/.test(raw)) return " DEFAULT " + raw;
  if (/^'.*'$/.test(raw)) return " DEFAULT " + raw;
  // SQLite expression defaults are not copied unless explicitly mapped above.
  return "";
}

function digestRows(rows, columns) {
  const hash = crypto.createHash("sha256");
  for (const row of rows) {
    const values = columns.map(column => {
      const value = row[column.name];
      if (Buffer.isBuffer(value)) return { buffer: value.toString("base64") };
      if (value === undefined || value === null) return null;
      if (/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/i.test(String(column.type || ""))) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : String(value);
      }
      return value;
    });
    hash.update(JSON.stringify(values) + "\n");
  }
  return hash.digest("hex");
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: "utf8mb4",
    connectionLimit: 2,
    connectTimeout: 10000,
    supportBigNumbers: true,
    bigNumberStrings: true
  });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query("SELECT 1");
    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY CASE name WHEN 'users' THEN 1 WHEN 'products' THEN 2 WHEN 'recurring_orders' THEN 3 WHEN 'orders' THEN 4 ELSE 5 END, name"
    ).all().map(row => row.name);

    const report = [];
    for (const table of tables) {
      try {
      const columns = sqlite.prepare("PRAGMA table_info(" + quote(table) + ")").all();
      if (!columns.length) continue;

      const indexes = sqlite.prepare("PRAGMA index_list(" + quote(table) + ")").all();
      const indexedColumns = new Set();
      for (const index of indexes) {
        for (const column of sqlite.prepare("PRAGMA index_info(" + quote(index.name) + ")").all()) {
          indexedColumns.add(column.name);
        }
      }

      const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(" + quote(table) + ")").all();
      const primaryKey = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk);
      const autoIncrementColumn = primaryKey.length === 1 && String(primaryKey[0].type).toUpperCase().includes("INT")
        ? primaryKey[0] : null;
      const definitions = columns.map(column => {
        const type = mysqlType(column, indexedColumns, column === autoIncrementColumn);
        const notNull = column.notnull && !column.pk ? " NOT NULL" : "";
        const defaultValue = column.pk ? "" : safeDefault(column.dflt_value, column);
        return quote(column.name) + " " + type + notNull + defaultValue;
      });

      if (primaryKey.length) {
        definitions.push("PRIMARY KEY (" + primaryKey.map(column => quote(column.name)).join(",") + ")");
      }

      for (const fk of foreignKeys) {
        definitions.push(
          "CONSTRAINT " + quote("fk_" + table + "_" + fk.id) +
          " FOREIGN KEY (" + quote(fk.from) + ") REFERENCES " + quote(fk.table) +
          " (" + quote(fk.to) + ") ON DELETE " +
          (fk.on_delete || "NO ACTION").toUpperCase().replace("RESTRICT", "RESTRICT")
        );
      }

      await connection.query(
        "CREATE TABLE IF NOT EXISTS " + quote(table) + " (" + definitions.join(",") +
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
      );

      const sourceRows = sqlite.prepare("SELECT * FROM " + quote(table)).all();
      const [targetRows] = await connection.query("SELECT COUNT(*) AS total FROM " + quote(table));
      const existingCount = Number(targetRows[0].total);
      if (existingCount !== 0) {
        const orderBy = primaryKey.length
          ? primaryKey.map(column => quote(column.name)).join(",")
          : quote(columns[0].name);
        const [existingData] = await connection.query("SELECT * FROM " + quote(table) + " ORDER BY " + orderBy);
        if (existingCount !== sourceRows.length ||
            digestRows(existingData, columns) !== digestRows(sourceRows, columns)) {
          throw new Error(
            "Doeltabel " + table + " bevat al gegevens die afwijken van SQLite. " +
            "Er is niets overschreven; herstel de MySQL-doeldatabase of gebruik een lege database."
          );
        }
        report.push({ table, rows: sourceRows.length, status: "bestond al en is geverifieerd" });
        continue;
      }

      if (sourceRows.length) {
        const insertSql = "INSERT INTO " + quote(table) + " (" +
          columns.map(column => quote(column.name)).join(",") + ") VALUES (" +
          columns.map(() => "?").join(",") + ")";
        await connection.query("SET FOREIGN_KEY_CHECKS=0");
        try {
          await connection.beginTransaction();
          for (let offset = 0; offset < sourceRows.length; offset += 100) {
            const batch = sourceRows.slice(offset, offset + 100);
            for (const row of batch) {
              await connection.execute(insertSql, columns.map(column => row[column.name]));
            }
          }
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          await connection.query("SET FOREIGN_KEY_CHECKS=1");
        }
      }

      for (const index of indexes) {
        if (index.origin === "pk") continue;
        // MySQL has no partial indexes. For this schema's partial unique index
        // on wc_customer_id, a normal UNIQUE index is equivalent because NULLs
        // are allowed more than once in MySQL.
        const indexColumns = sqlite.prepare("PRAGMA index_info(" + quote(index.name) + ")").all();
        if (!indexColumns.length) continue;
        const indexName = "mig_" + table + "_" + index.name;
        const indexSql = "CREATE " + (index.unique ? "UNIQUE " : "") + "INDEX " +
          quote(indexName) + " ON " + quote(table) + " (" +
          indexColumns.map(column => quote(column.name)).join(",") + ")";
        try {
          await connection.query(indexSql);
        } catch (error) {
          if (error.code !== "ER_DUP_KEYNAME" && error.code !== "ER_DUP_ENTRY") throw error;
        }
      }

      const [verified] = await connection.query("SELECT COUNT(*) AS total FROM " + quote(table));
      const targetCount = Number(verified[0].total);
      if (targetCount !== sourceRows.length) {
        throw new Error("Rijcontrole mislukt voor " + table + ": SQLite=" + sourceRows.length + ", MySQL=" + targetCount);
      }

      const targetData = [];
      const [rows] = await connection.query("SELECT * FROM " + quote(table) + " ORDER BY " +
        (primaryKey.length ? primaryKey.map(column => quote(column.name)).join(",") : quote(columns[0].name)));
      targetData.push(...rows);
      const sourceDigest = digestRows(sourceRows, columns);
      const targetDigest = digestRows(targetData, columns);
      if (sourceDigest !== targetDigest) {
        throw new Error("Inhoudscontrole mislukt voor " + table + "; SQLite blijft ongewijzigd.");
      }

      if (autoIncrementColumn && sourceRows.length) {
        const maxId = Math.max(...sourceRows.map(row => Number(row[autoIncrementColumn.name]) || 0));
        if (maxId > 0) await connection.query("ALTER TABLE " + quote(table) + " AUTO_INCREMENT = " + (maxId + 1));
      }

      report.push({ table, rows: sourceRows.length, sha256: sourceDigest, status: "geverifieerd" });
      } catch (error) {
        throw new Error("Tabel " + table + ": " + error.message);
      }
    }

    console.log(JSON.stringify({
      message: "Migratiekopie afgerond en per tabel gecontroleerd. De applicatie gebruikt nog SQLite.",
      sqlite: sqlitePath,
      mysqlDatabase: process.env.DB_NAME,
      tables: report
    }, null, 2));
  } finally {
    if (connection) connection.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch(error => {
  console.error("MySQL-migratie afgebroken:", error.message);
  process.exitCode = 1;
});
