"use strict";

const mysql = require("./mysql");

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");

  try {
    const rows = await mysql.query(
      "SELECT id,name,email,role,active FROM users WHERE id=? LIMIT 1",
      [req.session.user.id]
    );
    const user = rows[0];
    if (!user || Number(user.active) !== 1) {
      return req.session.destroy(() => res.redirect("/login?disabled=1"));
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role !== "admin") return res.status(403).send("Geen toegang.");
  return next();
}

module.exports = { requireAuth, requireAdmin };
