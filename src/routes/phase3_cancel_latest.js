// src/routes/phase3_cancel_latest.js
import { findLatestActiveBookingByWaFrom } from "../airtable/bookingsRead.js";
import { phase3CancelByRef } from "../phase3CancelByRef.js";

export async function phase3CancelLatest({ from }) {
  if (!from) {
    return {
      ok: false,
      reply: "Missing WhatsApp number.",
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

  const out = await phase3CancelByRef({ booking_ref });

  return {
    ...out,
    auto_found: true,
    booking_ref,
  };
}