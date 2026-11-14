"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {shiftDate,reminderSchedule}=require("../src/order-reminders");

test("order reminders are scheduled seven and three days before order date",()=>{
 assert.deepEqual(reminderSchedule("2026-12-25"),[
  {daysBefore:7,sendOn:"2026-12-18"},
  {daysBefore:3,sendOn:"2026-12-22"}
 ]);
});

test("date shifting handles month and year boundaries",()=>{
 assert.equal(shiftDate("2027-01-02",-3),"2026-12-30");
 assert.equal(shiftDate("2026-03-01",-1),"2026-02-28");
});

test("invalid dates and offsets are rejected",()=>{
 assert.throws(()=>shiftDate("2026-02-30",-7));
 assert.throws(()=>shiftDate("2026-01-01",1.5));
});
