"use strict";

function addBillingPeriod(dateString, interval) {
  const value = String(dateString || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !["week","month","year"].includes(interval)) {
    throw new Error("Ongeldige abonnementsdatum of periode.");
  }
  const date = new Date(value + "T12:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) {
    throw new Error("Ongeldige abonnementsdatum.");
  }
  if (interval === "week") date.setUTCDate(date.getUTCDate() + 7);
  else if (interval === "year") {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return date.toISOString().slice(0,10);
}

module.exports = { addBillingPeriod };
