// src/phase3PickAlt.js
import crypto from "node:crypto";
import { loadDraft, saveDraft } from "./redis.js";
import { createHoldEvent } from "./calendar/googleCalendar.js";

function addMinutes(date, min) {
  return new Date(date.getTime() + min * 60000);
}

function fmt2(n) {
  return String(n).padStart(2, "0");
}

function idempotencyKey({ from, service, date, time }) {
  const raw = `${from}|${service}|${date}|${time}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export async function phase3PickAlt({ from, choice }) {
  const draft = await loadDraft(from);

  if (draft.booking_status === "booked" && draft.event_id) {
    return { draft, reply: "Already confirmed ✅" };
  }

  if (draft.booking_status !== "offering_alts" || !Array.isArray(draft.alt_options)) {
    return { draft, reply: "Please request a time first, then I’ll offer options." };
  }

  const idx = Number(choice) - 1;
  if (![0, 1, 2].includes(idx)) {
    return { draft, reply: "Reply 1, 2, or 3." };
  }

  const picked = draft.alt_options[idx];
  if (!picked) {
    return { draft, reply: "That option is no longer available. Please request a new time." };
  }

  // Update draft to selected option
  draft.time = picked.time;
  draft.stylist_id = picked.stylist_id;
  draft.calendar_id = picked.calendar_id;

  // New idempotency key for the selected time
  draft.idempotency_key = idempotencyKey({
    from,
    service: draft.service,
    date: draft.date,
    time: draft.time,
  });

  const dur = draft.duration_min || 60;

  const start = new Date(`${draft.date}T${draft.time}:00`);
  const end = addMinutes(start, dur);

  const booking_ref = draft.booking_ref || crypto.randomBytes(4).toString("hex").toUpperCase();
  draft.booking_ref = booking_ref;

  const summary = `${draft.service} – ${draft.first_name} (${dur}m)`;
  const description = `Booked via WhatsApp\nRef: ${booking_ref}`;

  const hold = await createHoldEvent(draft.calendar_id, {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    timeZone: draft.tz || "Africa/Harare",
    summary,
    description,
    privateProps: {
      booking_ref,
      wa_from: from,
      stylist_id: draft.stylist_id,
      source: "whatsapp",
    },
  });

  // Set hold state
  draft.hold_event_id = hold.id;
  draft.hold_expires_at = Date.now() + 5 * 60 * 1000;
  draft.booking_status = "awaiting_confirm";
  draft.hold_idempotency_key = draft.idempotency_key;

  // Clear alt mode
  draft.alt_options = null;

  await saveDraft(from, draft);

  return {
    draft,
    reply: `Great — I’m holding **${draft.service}** on **${draft.date} ${draft.time}** for 5 minutes. Reply **CONFIRM** to book or **CHANGE** for other times.`,
  };
}