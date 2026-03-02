// src/phase3Cancel.js
import { loadDraft, saveDraft, decrUtil } from "./redis.js";
import { deleteEvent } from "./calendar/googleCalendar.js";
import { airtableUpdateRecord } from "./airtable/update.js";
import { findBookingByRef } from "./airtable/bookingsRead.js";

export async function phase3Cancel({ from }) {
  const draft = await loadDraft(from);

  // Idempotent: already cancelled
  if (draft.booking_status === "cancelled") {
    return { draft, reply: "This booking is already cancelled ✅" };
  }

  // If not booked yet, treat cancel like "change" (cancel hold if any)
  if (draft.booking_status !== "booked" || !draft.event_id) {
    // best-effort: delete hold if exists
    if (draft.hold_event_id && draft.calendar_id) {
      try { await deleteEvent(draft.calendar_id, draft.hold_event_id); } catch {}
    }

    draft.hold_event_id = null;
    draft.hold_expires_at = null;
    draft.hold_idempotency_key = null;
    draft.booking_status = "cancelled";
    await saveDraft(from, draft);

    return { draft, reply: "Cancelled ✅. If you'd like, tell me a new date/time to rebook." };
  }

  // 1) Delete Google Calendar event (confirmed booking)
  if (draft.calendar_id && draft.event_id) {
    try {
      await deleteEvent(draft.calendar_id, draft.event_id);
    } catch {
      // best effort: if already deleted, still proceed with Airtable + state
    }
  }

  // 2) Update Airtable booking record -> status=cancelled
  let recordId = draft.airtable_booking_record_id;

  if (!recordId && draft.booking_ref) {
    const rec = await findBookingByRef(draft.booking_ref);
    recordId = rec?.id || null;
  }

  if (recordId) {
    await airtableUpdateRecord("Bookings", recordId, { status: "cancelled" });
  }

  // 3) Decrement fairness counters (optional but recommended)
  try {
    if (draft.date && draft.stylist_id) {
      await decrUtil(draft.date, draft.stylist_id, draft.duration_min || 60);
    }
  } catch {
    // don't block cancellation if redis counter update fails
  }

  // 4) Clear hold fields; keep booking_ref for audit
  draft.hold_event_id = null;
  draft.hold_expires_at = null;
  draft.hold_idempotency_key = null;

  // Keep event_id for audit if you want, but mark cancelled
  draft.cancelled_event_id = draft.event_id;
  draft.event_id = null;

  draft.booking_status = "cancelled";
  draft.cancelled_at = Date.now();

  await saveDraft(from, draft);

  return {
    draft,
    reply: "Cancelled ✅. If you'd like, share a new date/time to rebook.",
  };
}