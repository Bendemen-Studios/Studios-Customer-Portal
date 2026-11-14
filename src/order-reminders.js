"use strict";

function shiftDate(dateString, days) {
 const value=String(dateString||"");
 if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)||!Number.isInteger(days)) {
  throw new Error("Ongeldige datum of dagverschuiving.");
 }
 const date=new Date(value+"T12:00:00.000Z");
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value) {
  throw new Error("Ongeldige datum.");
 }
 date.setUTCDate(date.getUTCDate()+days);
 return date.toISOString().slice(0,10);
}

function reminderSchedule(orderDate) {
 return [7,3].map(daysBefore=>({
  daysBefore,
  sendOn:shiftDate(orderDate,-daysBefore)
 }));
}

module.exports={shiftDate,reminderSchedule};
