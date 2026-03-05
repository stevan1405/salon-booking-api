// src/phase3Confirm.js
import { DateTime } from "luxon";

import { loadDraft, saveDraft, incrUtil } from "./redis.js";
import { confirmEvent, deleteEvent } from "./calendar/googleCalendar.js";
import { createBookingRecord } from "./airtable/bookings.js";
import { bookingExistsByRef } from "./airtable/bookingsRead.js";

// Normalize time into HH:mm (same helper as phase3.js)
function normalizeHHmm(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return s;
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = String(m[2] ?? "00").padStart(2, "0");
  return `${hh}:${mm}`;
}

export async function phase3Confirm({ from }) {
  const draft = (await loadDraft(from)) || {};

  // Normalize time defensively (important for Luxon fallback)
  draft.time = normalizeHHmm(draft.time);
  draft.tz = draft.tz || "Africa/Harare";

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
    draft.hold_start_iso = null;
    draft.hold_end_iso = null;

    // #4: clear event_id only if not booked
    if (draft.booking_status !== "booked") {
      draft.event_id = null;
    }

    draft.booking_status = "draft";
    await saveDraft(from, draft);

    return { draft, reply: "That hold expired. Please share a new time you'd like." };
  }

  // Build the same summary/props on confirm (so calendar entry stays consistent)
  const stylistName = draft.stylist_name || "";
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
  await confirmEvent(draft.calendar_id, draft.hold_event_id, { summary, privateProps });

  // mark booked
  draft.booking_status = "booked";
  draft.event_id = draft.hold_event_id;

  const duration = draft.duration_min || 60;

  // Fairness counter update
  if (draft.stylist_id && draft.date) {
    await incrUtil(draft.date, draft.stylist_id, duration);
  }

  // --- Build ISO timestamps for Airtable record (timezone-correct) ---
  // Prefer the exact UTC instants used for the hold.
  let startIso = draft.hold_start_iso || null;
  let endIso = draft.hold_end_iso || null;

  // Fallback for older drafts: compute from local time in draft.tz using Luxon
  if (!startIso || !endIso) {
    const zone = draft.tz || "Africa/Harare";
    const t = normalizeHHmm(draft.time);

    const startLocal = DateTime.fromISO(`${draft.date}T${t}`, { zone });
    if (!startLocal.isValid) {
      throw new Error(`Invalid local datetime: ${draft.date} ${draft.time} (${zone})`);
    }

    const endLocal = startLocal.plus({ minutes: Number(duration) });
    startIso = startLocal.toUTC().toISO();
    endIso = endLocal.toUTC().toISO();

    // store so other flows stay consistent
    draft.hold_start_iso = startIso;
    draft.hold_end_iso = endIso;
  }
  // ---------------------------------------------------------------

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
    start_iso: startIso,
    end_iso: endIso,
    status: "confirmed",
    gcal_event_id: draft.hold_event_id,
  });

  // store Airtable record id for later cancel/reschedule
  draft.airtable_booking_record_id = created?.id || null;

  // Mark booked (redundant but safe)
  draft.booking_status = "booked";
  draft.event_id = draft.hold_event_id;

  await saveDraft(from, draft);

  return {
    draft,
    reply: `🎉 Confirmed! **${draft.service}** on **${draft.date} ${draft.time}**. See you then.`,
  };
}