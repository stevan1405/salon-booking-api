// src/routes/phase3_reschedule_latest.js
import { findLatestActiveBookingByWaFrom } from "../airtable/bookingsRead.js";
import { phase3RescheduleByRef } from "../phase3RescheduleByRef.js";

function normalizeHHmm(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return s;
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = String(m[2] ?? "00").padStart(2, "0");
  return `${hh}:${mm}`;
}

export async function phase3RescheduleLatest({ from, new_date, new_time }) {
  if (!from) {
    return {
      ok: false,
      reply: "Missing WhatsApp number.",
    };
  }

  if (!new_date || !new_time) {
    return {
      ok: false,
      reply: "Please provide the new date and time.",
    };
  }

  const rec = await findLatestActiveBookingByWaFrom(from);

  if (!rec) {
    return {
      ok: false,
      reply: "I couldn’t find an active booking for this number.",
    };
  }

  const fields = rec.fields || {};
  const booking_ref = fields.booking_ref || null;

  if (!booking_ref) {
    return {
      ok: false,
      reply: "I found a booking, but it has no booking reference. Please contact support.",
    };
  }

  const out = await phase3RescheduleByRef({
    booking_ref,
    new_date,
    new_time: normalizeHHmm(new_time),
  });

  return {
    ...out,
    auto_found: true,
    booking_ref,
  };
}