// src/phase3Confirm.js
import { DateTime } from "luxon";

import { confirmEvent, deleteEvent } from "./calendar/googleCalendar.js";
import { createBookingRecord } from "./airtable/bookings.js";
import { bookingExistsByRef } from "./airtable/bookingsRead.js";
import { loadDraft, saveDraft, incrUtil, acquireLock, releaseLock } from "./redis.js";

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
  let draft = (await loadDraft(from)) || {};

  // Defensive normalization
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

  // Expired hold -> cleanup (best effort) and reset to draft
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

    if (draft.booking_status !== "booked") {
      draft.event_id = null;
    }

    draft.booking_status = "draft";
    await saveDraft(from, draft);

    return { draft, reply: "That hold expired. Please share a new time you'd like." };
  }

  // --- Double-confirm race lock ---
  // Prefer booking_ref for lock uniqueness; fallback to from
  const lockKey = `lock:confirm:${draft.booking_ref || from}`;
  const lockToken = await acquireLock(lockKey, 15000); // 15s

  if (!lockToken) {
    return { draft, reply: "Confirming… one moment ✅" };
  }

  try {
    // Re-load inside lock so concurrent confirms see the latest state
    draft = (await loadDraft(from)) || {};
    draft.time = normalizeHHmm(draft.time);
    draft.tz = draft.tz || "Africa/Harare";

    // If someone else already confirmed while we waited, exit cleanly
    if (draft.booking_status === "booked" && draft.event_id) {
      return { draft, reply: "Already confirmed ✅" };
    }

    // Still must have hold
    if (!draft.hold_event_id || !draft.calendar_id) {
      return { draft, reply: "I don’t see an active hold. Please request a time first." };
    }

    // Still must be unexpired
    if (!draft.hold_expires_at || Date.now() > draft.hold_expires_at) {
      // Best effort delete then reset
      try {
        await deleteEvent(draft.calendar_id, draft.hold_event_id);
      } catch {}

      draft.hold_event_id = null;
      draft.hold_expires_at = null;
      draft.hold_idempotency_key = null;
      draft.hold_start_iso = null;
      draft.hold_end_iso = null;
      if (draft.booking_status !== "booked") draft.event_id = null;
      draft.booking_status = "draft";
      await saveDraft(from, draft);

      return { draft, reply: "That hold expired. Please share a new time you'd like." };
    }

    // Airtable idempotency (inside lock): if row already exists, mark booked and return
    if (draft.booking_ref && (await bookingExistsByRef(draft.booking_ref))) {
      draft.booking_status = "booked";
      draft.event_id = draft.hold_event_id || draft.event_id;

      // clear hold fields (optional but keeps state clean)
      draft.hold_event_id = null;
      draft.hold_expires_at = null;
      draft.hold_idempotency_key = null;

      await saveDraft(from, draft);
      return { draft, reply: "Already confirmed ✅" };
    }

    // Build summary/props (keep calendar entry consistent)
    const stylistName = draft.stylist_name || "";
    const summary =
      `${draft.service} — ${draft.first_name || "Guest"}` +
      (stylistName ? ` — ${stylistName}` : "") +
      (draft.stylist_id ? ` (${draft.stylist_id})` : "");

    const privateProps = {
      source: "salon-bot",
      booking_ref: draft.booking_ref || "",
      stylist_id: draft.stylist_id || "",
      stylist_name: stylistName || "",
      service: draft.service || "",
      wa_from: draft.from || from || "",
    };

    // Confirm + update event details
    await confirmEvent(draft.calendar_id, draft.hold_event_id, { summary, privateProps });

    // Mark booked immediately (state first)
    draft.booking_status = "booked";
    draft.event_id = draft.hold_event_id;

    const duration = Number(draft.duration_min || 60);

    // Fairness counter update
    if (draft.stylist_id && draft.date) {
      await incrUtil(draft.date, draft.stylist_id, duration);
    }

    // --- Build ISO timestamps for Airtable record (timezone-correct) ---
    // Prefer the exact UTC instants used for the hold.
    let startIso = draft.hold_start_iso || null;
    let endIso = draft.hold_end_iso || null;

    // Fallback: compute from local time in draft.tz using Luxon
    if (!startIso || !endIso) {
      const zone = draft.tz || "Africa/Harare";
      const t = normalizeHHmm(draft.time);

      const startLocal = DateTime.fromISO(`${draft.date}T${t}`, { zone });
      if (!startLocal.isValid) {
        throw new Error(`Invalid local datetime: ${draft.date} ${draft.time} (${zone})`);
      }

      const endLocal = startLocal.plus({ minutes: duration });
      startIso = startLocal.toUTC().toISO();
      endIso = endLocal.toUTC().toISO();

      // store for consistency
      draft.hold_start_iso = startIso;
      draft.hold_end_iso = endIso;
    }
    // ---------------------------------------------------------------

    // Create Airtable record
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

    draft.airtable_booking_record_id = created?.id || null;

    // Clear hold fields now that booking is confirmed
    draft.hold_event_id = null;
    draft.hold_expires_at = null;
    draft.hold_idempotency_key = null;

    await saveDraft(from, draft);

    return {
      draft,
      reply: `🎉 Confirmed! **${draft.service}** on **${draft.date} ${draft.time}**. See you then.`,
    };
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}