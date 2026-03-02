// src/phase3CancelByRef.js
import { findBookingByRef } from "./airtable/bookingsRead.js";
import { airtableUpdateRecord } from "./airtable/update.js";
import { findStylistById } from "./airtable/stylistsRead.js";
import { deleteEvent } from "./calendar/googleCalendar.js";
import { decrUtil, loadDraft, saveDraft } from "./redis.js";

function dateFromIso(iso) {
  // iso like "2026-03-03T10:00:00.000Z"
  if (!iso || typeof iso !== "string") return null;
  return iso.slice(0, 10);
}

function durationMinFromIso(startIso, endIso) {
  try {
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
    return Math.round((e - s) / 60000);
  } catch {
    return null;
  }
}

export async function phase3CancelByRef({ booking_ref }) {
  // 1) Find booking record
  const rec = await findBookingByRef(booking_ref);
  if (!rec) {
    return {
      ok: false,
      reply: `I can’t find booking ref ${booking_ref}.`,
    };
  }

  const fields = rec.fields || {};
  const stylist_id = fields.stylist_id;
  const gcal_event_id = fields.gcal_event_id;
  const wa_from = fields.wa_from;
  const start_iso = fields.start_iso;
  const end_iso = fields.end_iso;

  // Idempotent: already cancelled
  if (String(fields.status || "").toLowerCase() === "cancelled") {
    return {
      ok: true,
      reply: `Booking ${booking_ref} is already cancelled ✅`,
    };
  }

  // 2) Find stylist calendar_id
  let calendar_id = null;
  if (stylist_id) {
    const stylistRec = await findStylistById(stylist_id);
    calendar_id = stylistRec?.fields?.calendar_id || null;
  }

  // 3) Delete Google event (best effort)
  if (calendar_id && gcal_event_id) {
    try {
      await deleteEvent(calendar_id, gcal_event_id);
    } catch {
      // If it was already deleted or not found, we still proceed to cancel in Airtable
    }
  }

  // 4) Update Airtable status
  await airtableUpdateRecord("Bookings", rec.id, { status: "cancelled" });

  // 5) Decrement fairness counters (best effort)
  try {
    const dateKey = dateFromIso(start_iso);
    const dur = durationMinFromIso(start_iso, end_iso) || 60;
    if (dateKey && stylist_id) {
      await decrUtil(dateKey, stylist_id, dur);
    }
  } catch {}

  // 6) Optional: update Redis draft for that WhatsApp number (best effort)
  if (wa_from) {
    try {
      const draft = await loadDraft(wa_from);
      draft.booking_status = "cancelled";
      draft.cancelled_booking_ref = booking_ref;
      draft.event_id = null;
      draft.hold_event_id = null;
      draft.hold_expires_at = null;
      draft.hold_idempotency_key = null;
      await saveDraft(wa_from, draft);
    } catch {}
  }

  return {
    ok: true,
    reply: `Cancelled ✅ Booking ref ${booking_ref}.`,
    cancelled: {
      booking_ref,
      stylist_id,
      calendar_id,
      gcal_event_id,
      wa_from,
    },
  };
}