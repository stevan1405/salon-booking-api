// src/calendar/workingHours.js

function toMin(t) {
  const [h, m] = String(t).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

function getDayKey(dateYYYYMMDD) {
  const day = new Date(`${dateYYYYMMDD}T00:00:00`).getDay(); // 0 Sun .. 6 Sat
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][day];
}

/**
 * Returns true if the requested slot [startHHmm, endHHmm] fits inside
 * one of the stylist's working windows for that day.
 *
 * Rules:
 * - No windows for the day => NOT available
 * - Supports multiple windows per day
 * - Supports overnight windows like 22:00 -> 02:00
 */
export function isWithinWorkingHours(workingHoursJson, dateYYYYMMDD, startHHmm, endHHmm) {
  let wh;
  try {
    wh = JSON.parse(workingHoursJson || "{}");
  } catch {
    wh = {};
  }

  const key = getDayKey(dateYYYYMMDD);
  const windows = Array.isArray(wh[key]) ? wh[key] : [];

  // Explicit admin-controlled availability:
  // if no windows are configured for that day, stylist is off
  if (windows.length === 0) return false;

  const s = toMin(startHHmm);
  const e = toMin(endHHmm);

  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;

  return windows.some((w) => {
    if (!w || !w.start || !w.end) return false;

    const ws = toMin(w.start);
    const we = toMin(w.end);

    if (!Number.isFinite(ws) || !Number.isFinite(we)) return false;

    // Normal same-day window, e.g. 09:00 -> 17:00
    if (ws <= we) {
      return s >= ws && e <= we;
    }

    // Overnight window, e.g. 22:00 -> 02:00
    // Interpreted as available from ws -> midnight, then midnight -> we
    // For same-day checks, allow:
    // - slot fully in late-night portion: s >= ws
    // - slot fully in early-morning portion: e <= we
    return s >= ws || e <= we;
  });
}