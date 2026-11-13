// Start de MySQL-migratie rechtstreeks vanuit de hoofdmap.
// Uitvoeren op de server: node migrate.js
console.log("Bendemen Supply Panel: MySQL-migratie starten...");
require("./scripts/migrate-to-mysql.js");
