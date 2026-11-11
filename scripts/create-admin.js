require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const bcrypt = require("bcryptjs");
const db = require("../src/db");

async function main() {
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (password.length < 12) {
    throw new Error("Stel ADMIN_PASSWORD in op minimaal 12 tekens en voer npm run create-admin opnieuw uit.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    "UPDATE users SET password_hash=?, role='admin', active=1 WHERE email=? COLLATE NOCASE"
  ).run(passwordHash, "info@bendemen.nl");

  if (!result.changes) throw new Error("Adminaccount info@bendemen.nl is niet gevonden.");
  console.log("Adminwachtwoord ingesteld voor info@bendemen.nl.");
  db.close();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
