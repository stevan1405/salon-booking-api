// src/calendar/workingHours.js

// If a stylist has no working hours configured for a given day,
// we treat them as AVAILABLE (24/7) by default.
// This lets you support late bookings (e.g. 21:00) and rely on:
//  - per-stylist working_hours_json when provided
//  - Google Calendar busy events for actual availability
export function isWithinWorkingHours(workingHoursJson, dateYYYYMMDD, startHHmm, endHHmm) {
  let wh;
  try {
    wh = JSON.parse(workingHoursJson || "{}");
  } catch {
    wh = {};
  }

  const day = new Date(`${dateYYYYMMDD}T00:00:00`).getDay(); // 0 Sun .. 6 Sat
  const key = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][day];

  const windows = Array.isArray(wh[key]) ? wh[key] : [];

  // ✅ 24/7 default if no windows configured for that day
  if (windows.length === 0) return true;

  // Compare times as minutes since midnight
  const toMin = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + m;
  };

  const s = toMin(startHHmm);
  const e = toMin(endHHmm);

  // Guard: if parse fails
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;

  return windows.some((w) => {
    if (!w || !w.start || !w.end) return false;
    const ws = toMin(w.start);
    const we = toMin(w.end);
    if (!Number.isFinite(ws) || !Number.isFinite(we)) return false;
    return s >= ws && e <= we;
  });
}