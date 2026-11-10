require("dotenv").config();
const db = require("../src/db");
const admin = db.prepare("SELECT id,email,role,active FROM users WHERE email=? COLLATE NOCASE").get("info@bendemen.nl");
if (!admin) throw new Error("Admin account missing");
console.log("Admin account ready:", admin.email, admin.role, "active:", Boolean(admin.active));
