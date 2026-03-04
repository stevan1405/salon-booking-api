// src/phase3Confirm.js
import { loadDraft, saveDraft, incrUtil } from "./redis.js";
import { confirmEvent, deleteEvent } from "./calendar/googleCalendar.js";
import { createBookingRecord } from "./airtable/bookings.js";
import { bookingExistsByRef } from "./airtable/bookingsRead.js";
import { DateTime } from "luxon";

export async function phase3Confirm({ from }) {
  const draft = await loadDraft(from);

  // Idempotent confirm: if already booked, do nothing
  if (draft.booking_status === "booked" && draft.event_id) {
    return { draft, reply: "Already confirmed ✅" };
  }

  // No active hold
  if (!draft.hold_event_id || !draft.calendar_id) {
    return { draft, reply: "I don’t see an active hold. Please request a time first." };
  }

  // Hold exists but missing expiry (invalid hold)
  if (!draft.hold_expires_at) {
    return { draft, reply: "Your hold looks incomplete. Please request the time again." };
  }

  // Expired hold -> cleanup
  if (Date.now() > draft.hold_expires_at) {
    try {
      await deleteEvent(draft.calendar_id, draft.hold_event_id);
    } catch {
      // best effort cleanup
    }

    draft.hold_event_id = null;
    draft.hold_expires_at = null;
    draft.hold_idempotency_key = null;

    // #4: clear event_id only if not booked
    if (draft.booking_status !== "booked") {
      draft.event_id = null;
    }

    draft.booking_status = "draft";
    await saveDraft(from, draft);

    return { draft, reply: "That hold expired. Please share a new time you'd like." };
  }

  // Build the same summary/props on confirm (so calendar entry stays consistent)
  const stylistName = draft.stylist_name || ""; // if you stored it; otherwise leave ""
  const summary =
    `${draft.service} — ${draft.first_name || "Guest"}` +
    (stylistName ? ` — ${stylistName}` : "") +
    (draft.stylist_id ? ` (${draft.stylist_id})` : "");

  const privateProps = {
    source: "salon-bot",
    booking_ref: draft.booking_ref,
    stylist_id: draft.stylist_id || "",
    stylist_name: stylistName || "",
    service: draft.service || "",
    wa_from: draft.from || "",
  };

  // Confirm + update event details in one call
  // Confirm + update event details in one call
  await confirmEvent(draft.calendar_id, draft.hold_event_id, { summary, privateProps });

  // mark booked
  draft.booking_status = "booked";
  draft.event_id = draft.hold_event_id;

  const duration = draft.duration_min || 60;

  // Fairness counter update
  if (draft.stylist_id && draft.date) {
    await incrUtil(draft.date, draft.stylist_id, duration);
  }

  // Build ISO timestamps for Airtable record
  const start = new Date(`${draft.date}T${draft.time}:00`);
  const end = new Date(start.getTime() + duration * 60000);

  // Airtable idempotency: don't create duplicate rows
  if (draft.booking_ref && (await bookingExistsByRef(draft.booking_ref))) {
    draft.booking_status = "booked";
    draft.event_id = draft.hold_event_id || draft.event_id;

    await saveDraft(from, draft);
    return { draft, reply: "Already confirmed ✅" };
  }

  // Write confirmed booking to Airtable
  const created = await createBookingRecord({
    booking_ref: draft.booking_ref,
    first_name: draft.first_name,
    wa_from: from,
    service_id: draft.service,
    stylist_id: draft.stylist_id,
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
    status: "confirmed",
    gcal_event_id: draft.hold_event_id,
  });

  // store Airtable record id for later cancel/reschedule
  draft.airtable_booking_record_id = created?.id || null;

  // Mark booked
  draft.booking_status = "booked";
  draft.event_id = draft.hold_event_id;

  await saveDraft(from, draft);

  return {
    draft,
    reply: `🎉 Confirmed! **${draft.service}** on **${draft.date} ${draft.time}**. See you then.`,
  };
}