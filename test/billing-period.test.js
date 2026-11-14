"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { addBillingPeriod } = require("../src/billing-period");

test("monthly billing clamps end-of-month dates", () => {
  assert.equal(addBillingPeriod("2026-01-31","month"),"2026-02-28");
  assert.equal(addBillingPeriod("2024-01-31","month"),"2024-02-29");
  assert.equal(addBillingPeriod("2026-03-31","month"),"2026-04-30");
});

test("weekly and yearly billing preserve the calendar date", () => {
  assert.equal(addBillingPeriod("2026-11-14","week"),"2026-11-21");
  assert.equal(addBillingPeriod("2024-02-29","year"),"2025-02-28");
});

test("invalid billing dates and intervals are rejected", () => {
  assert.throws(() => addBillingPeriod("2026-02-30","month"));
  assert.throws(() => addBillingPeriod("2026-01-01","daily"));
});
