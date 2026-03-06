// src/phase3RescheduleByRef.js
import { findBookingByRef } from "./airtable/bookingsRead.js";
import { airtableUpdateRecord } from "./airtable/update.js";
import { findStylistById } from "./airtable/stylistsRead.js";
import { deleteEvent } from "./calendar/googleCalendar.js";
import { decrUtil, loadDraft, saveDraft } from "./redis.js";
import { phase3Handle } from "./phase3.js";

function dateFromIso(iso) {
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

/**
 * Reschedule an existing confirmed booking by booking_ref.
 * Creates a NEW hold (new booking_ref), and marks old Airtable record as rescheduled.
 */
export async function phase3RescheduleByRef({ booking_ref, new_date, new_time }) {
  // 1) Find existing booking
  const rec = await findBookingByRef(booking_ref);
  if (!rec) {
    return { ok: false, reply: `I can’t find booking ref ${booking_ref}.` };
  }

  const fields = rec.fields || {};
  const oldStatus = String(fields.status || "").toLowerCase();

  if (oldStatus === "cancelled") {
    return { ok: false, reply: `That booking (${booking_ref}) is cancelled already. Please book a new time.` };
  }

  // We allow rescheduling a confirmed booking; if it’s already rescheduled, we still proceed idempotently.
  const stylist_id = fields.stylist_id;
  const gcal_event_id = fields.gcal_event_id;
  const wa_from = fields.wa_from;
  const first_name = fields.first_name;
  const service = fields.service_id; // in your MVP, service_id stores service name
  const start_iso = fields.start_iso;
  const end_iso = fields.end_iso;

  // 2) Resolve calendar_id from stylist_id
  let calendar_id = null;
  if (stylist_id) {
    const stylistRec = await findStylistById(stylist_id);
    calendar_id = stylistRec?.fields?.calendar_id || null;
  }

  // 3) Delete old Google event (best effort)
  if (calendar_id && gcal_event_id && oldStatus !== "rescheduled") {
    try {
      await deleteEvent(calendar_id, gcal_event_id);
    } catch {
      // proceed anyway
    }
  }

  // 4) Update Airtable old record => status = rescheduled
  // NOTE: This requires "rescheduled" to exist as a Single Select option.
  if (oldStatus !== "rescheduled") {
    await airtableUpdateRecord("Bookings", rec.id, { status: "rescheduled" });
  }

  // 5) Decrement fairness counters (best effort)
  try {
    const dateKey = dateFromIso(start_iso);
    const dur = durationMinFromIso(start_iso, end_iso) || 60;
    if (dateKey && stylist_id) {
      await decrUtil(dateKey, stylist_id, dur);
    }
  } catch {}

  // 6) Start NEW booking flow for the new time (new hold + new booking_ref)
  // We drive this through your existing phase3Handle by preparing a clean draft.
    const draft = (await loadDraft(wa_from)) || {};

  // --- NEW: cleanup any existing hold on this WhatsApp thread (best effort) ---
  // This prevents "double events" if someone reschedules again after a hold expires
  // and the old hold wasn't deleted (or confirm wasn't called).
  if (draft.hold_event_id && draft.calendar_id && draft.booking_status !== "booked") {
    try {
      await deleteEvent(draft.calendar_id, draft.hold_event_id);
    } catch {
      // best effort cleanup
    }
  }
  // --------------------------------------------------------------------------

  // Reset state so phase3Handle won't short-circuit as "booked"
  draft.from = wa_from;
  draft.booking_status = "draft";
  draft.event_id = null;

  // Clear any hold state
  draft.hold_event_id = null;
  draft.hold_expires_at = null;
  draft.hold_idempotency_key = null;
  draft.hold_start_iso = null;
  draft.hold_end_iso = null;

  // IMPORTANT: clear booking_ref so the NEW booking gets a NEW ref
  draft.booking_ref = null;
  draft.airtable_booking_record_id = null;

  // Clear any prior alts
  draft.alt_options = null;

  // Carry forward user/service identity
  draft.first_name = first_name || draft.first_name;
  draft.service = service || draft.service;
  draft.date = new_date;
  draft.time = new_time;

  // Keep TZ
  draft.tz = draft.tz || "Africa/Harare";

  await saveDraft(wa_from, draft);

  // Now run the normal booking engine to create a new hold or alternatives
  const out = await phase3Handle({
    from: wa_from,
    extracted: {
      service: draft.service,
      date: new_date,
      time: new_time,
      first_name: draft.first_name,
    },
  });

  return {
    ok: true,
    reply:
      `Rescheduled ✅ Old ref ${booking_ref} marked as rescheduled.\n\n` +
      out.reply,
    draft: out.draft,
    old_booking_ref: booking_ref,
  };
}