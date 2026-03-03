// src/phase3.js
import crypto from "node:crypto";
import { getActiveStylists, getServiceDurationMin } from "./airtable/read.js";
import { loadDraft, saveDraft, getUtil } from "./redis.js";
import { isWithinWorkingHours } from "./calendar/workingHours.js";
import { freeBusy, createHoldEvent } from "./calendar/googleCalendar.js";

function addMinutes(date, min) {
  return new Date(date.getTime() + min * 60000);
}

function fmt2(n) {
  return String(n).padStart(2, "0");
}

function toHHmm(date) {
  return `${fmt2(date.getHours())}:${fmt2(date.getMinutes())}`;
}

function makeBookingRef() {
  return crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
}

// Stable idempotency key for "same booking intent"
function idempotencyKey({ from, service, date, time }) {
  const raw = `${from}|${service}|${date}|${time}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// Parse "YYYY-MM-DD" + "HH:mm" into a Date.
// NOTE: For MVP we keep this consistent with your existing behavior.
function makeLocalDate(dateYYYYMMDD, timeHHmm) {
  return new Date(`${dateYYYYMMDD}T${timeHHmm}:00`);
}

function pickFairStylistForSlot(freeStylistsWithUtil) {
  // freeStylistsWithUtil: [{ s, util }]
  freeStylistsWithUtil.sort((a, b) => {
    const am = a.util.booked_minutes || 0;
    const bm = b.util.booked_minutes || 0;
    if (am !== bm) return am - bm;

    const ac = a.util.appt_count || 0;
    const bc = b.util.appt_count || 0;
    if (ac !== bc) return ac - bc;

    return String(a.s.stylist_id || "").localeCompare(String(b.s.stylist_id || ""));
  });
  return freeStylistsWithUtil[0]?.s || null;
}

/**
 * Find next available options (team) in 30-min increments, return N options.
 * - Respects working hours per stylist
 * - Uses FreeBusy across eligible calendars for each candidate slot
 * - Picks stylist for each candidate slot via fairness counters
 */
async function findNextTeamOptions({
  stylists,
  dateYYYYMMDD,
  startTimeHHmm,
  durationMin,
  tz,
  optionsCount = 3,
  stepMin = 30,
  maxSteps = 24, // 24 * 30min = 12 hours lookahead
}) {
  const results = [];

  let cursor = makeLocalDate(dateYYYYMMDD, startTimeHHmm);

  for (let i = 0; i < maxSteps && results.length < optionsCount; i++) {
    // move forward by step (skip i=0 if you already tried requested time)
    cursor = addMinutes(cursor, stepMin);

    const slotStart = cursor;
    const slotEnd = addMinutes(slotStart, durationMin);

    const slotStartHHmm = toHHmm(slotStart);
    const slotEndHHmm = toHHmm(slotEnd);

    // filter by working hours for this slot
    const eligible = stylists.filter((s) =>
      isWithinWorkingHours(s.working_hours_json, dateYYYYMMDD, slotStartHHmm, slotEndHHmm)
    );
    if (!eligible.length) continue;

    // FreeBusy check for this slot across eligible calendars
    const fb = await freeBusy(
      eligible.map((s) => s.calendar_id),
      slotStart.toISOString(),
      slotEnd.toISOString(),
      tz
    );

    const free = eligible.filter((s) => {
      const cal = fb[s.calendar_id];
      const busy = cal?.busy || [];
      return busy.length === 0;
    });

    if (!free.length) continue;

    // Fairness selection for this slot
    const withUtil = await Promise.all(
      free.map(async (s) => ({ s, util: await getUtil(dateYYYYMMDD, s.stylist_id) }))
    );

    const chosen = pickFairStylistForSlot(withUtil);
    if (!chosen) continue;

    results.push({
      time: slotStartHHmm,
      stylist_id: chosen.stylist_id,
      stylist_name: chosen.name,
      calendar_id: chosen.calendar_id,
    });
  }

  return results;
}

export async function phase3Handle({ from, extracted }) {
  const draft = await loadDraft(from);

  // Merge fields
  draft.from = from;
  draft.service = extracted.service ?? draft.service;
  draft.date = extracted.date ?? draft.date; // YYYY-MM-DD
  draft.time = extracted.time ?? draft.time; // HH:mm
  draft.first_name = extracted.first_name ?? draft.first_name;
  draft.stylist_name = extracted.stylist_name ?? draft.stylist_name; // optional
  draft.tz = draft.tz || "Africa/Harare";

  // Missing-field handling
  for (const f of ["service", "date", "time", "first_name"]) {
    if (!draft[f]) {
      await saveDraft(from, draft);
      return { draft, reply: `Please share your ${f.replace("_", " ")}.` };
    }
  }

  // Compute idempotency key
  draft.idempotency_key = idempotencyKey({
    from,
    service: draft.service,
    date: draft.date,
    time: draft.time,
  });

  // If already booked, do not re-run availability or create holds
  if (draft.booking_status === "booked" && draft.event_id) {
    await saveDraft(from, draft);
    return {
      draft,
      reply: `Already confirmed ✅ **${draft.service}** on **${draft.date} ${draft.time}**.`,
    };
  }

  // Duration from Airtable services; fallback 60
  const dur = (await getServiceDurationMin(draft.service)) ?? 60;
  draft.duration_min = dur;

  // Reuse active hold if it matches this same intent
  const holdStillValid =
    draft.booking_status === "awaiting_confirm" &&
    draft.hold_event_id &&
    draft.hold_expires_at &&
    Date.now() <= draft.hold_expires_at;

  if (holdStillValid && draft.hold_idempotency_key === draft.idempotency_key) {
    await saveDraft(from, draft);
    return {
      draft,
      reply: `Your hold is still active for **${draft.service}** on **${draft.date} ${draft.time}**. Reply **CONFIRM** to book or **CHANGE** for other times.`,
    };
  }

  // Requested window
  const start = makeLocalDate(draft.date, draft.time);
  const end = addMinutes(start, dur);

  const startISO = start.toISOString();
  const endISO = end.toISOString();

  // Load stylists
  const stylists = await getActiveStylists();

  // Stylist preference: specific if stylist_name matches else any
  let pref = "any";
  let preferredStylists = stylists;

  if (draft.stylist_name) {
    const sn = String(draft.stylist_name).toLowerCase();
    const match = stylists.filter((s) => String(s.name || "").toLowerCase().includes(sn));
    if (match.length) {
      pref = "specific";
      preferredStylists = match;
      draft.stylist_pref = { type: "specific", stylist_id: match[0].stylist_id };
    } else {
      draft.stylist_pref = { type: "any" };
    }
  } else {
    draft.stylist_pref = { type: "any" };
  }

  // Working-hours filter for the requested slot
  const startHHmm = toHHmm(start);
  const endHHmm = toHHmm(end);

  const eligible = preferredStylists.filter((s) =>
    isWithinWorkingHours(s.working_hours_json, draft.date, startHHmm, endHHmm)
  );

  if (!eligible.length) {
    await saveDraft(from, draft);
    return { draft, reply: `No stylists are working at ${draft.time}. Try another time?` };
  }

  // FreeBusy check for requested slot
  const fb = await freeBusy(
    eligible.map((s) => s.calendar_id),
    startISO,
    endISO,
    draft.tz
  );

  const free = eligible.filter((s) => {
    const cal = fb[s.calendar_id];
    const busy = cal?.busy || [];
    return busy.length === 0;
  });

  // ---- NEW: offer alternatives (30 min increments, 3 options) when no one is free ----
  if (!free.length) {
    // If specific stylist preference, keep current message (we can add specific alternatives next)
    if (pref === "specific") {
      await saveDraft(from, draft);
      return {
        draft,
        reply: `That time is taken with **${draft.stylist_name}**. Reply CHANGE for other times, or reply ANY for the soonest available stylist.`,
      };
    }

    // Team alternatives (any stylist)
    async function findNextTeamOptions({
      stylists,
      dateYYYYMMDD,
      startTimeHHmm,
      durationMin,
      tz,
      optionsCount = 3,
      stepMin = 30,
      maxSteps = 24,
    }) {
      const results = [];
      const usedStylists = new Set();

      let cursor = makeLocalDate(dateYYYYMMDD, startTimeHHmm);

      for (let i = 0; i < maxSteps && results.length < optionsCount; i++) {
        cursor = addMinutes(cursor, stepMin);

        const slotStart = cursor;
        const slotEnd = addMinutes(slotStart, durationMin);

        const slotStartHHmm = toHHmm(slotStart);
        const slotEndHHmm = toHHmm(slotEnd);

        const eligible = stylists.filter((s) =>
          isWithinWorkingHours(s.working_hours_json, dateYYYYMMDD, slotStartHHmm, slotEndHHmm)
        );
        if (!eligible.length) continue;

        const fb = await freeBusy(
          eligible.map((s) => s.calendar_id),
          slotStart.toISOString(),
          slotEnd.toISOString(),
          tz
        );

        const free = eligible.filter((s) => {
          const cal = fb[s.calendar_id];
          const busy = cal?.busy || [];
          return busy.length === 0;
        });

        if (!free.length) continue;

        const withUtil = await Promise.all(
          free.map(async (s) => ({ s, util: await getUtil(dateYYYYMMDD, s.stylist_id) }))
        );

        // Sort by fairness
        withUtil.sort((a, b) => {
          const am = a.util.booked_minutes || 0;
          const bm = b.util.booked_minutes || 0;
          if (am !== bm) return am - bm;

          const ac = a.util.appt_count || 0;
          const bc = b.util.appt_count || 0;
          if (ac !== bc) return ac - bc;

          return String(a.s.stylist_id).localeCompare(String(b.s.stylist_id));
        });

        // Prefer a stylist not already used in options
        let chosenObj =
          withUtil.find((x) => !usedStylists.has(x.s.stylist_id)) ||
          withUtil[0]; // fallback if all used

          if (!chosenObj) continue;

        usedStylists.add(chosenObj.s.stylist_id);

        results.push({
          time: slotStartHHmm,
          stylist_id: chosenObj.s.stylist_id,
          stylist_name: chosenObj.s.name,
          calendar_id: chosenObj.s.calendar_id,
        });
      }

      return results;
    }

    await saveDraft(from, draft);

    if (!options.length) {
      return {
        draft,
        reply: `No stylists are free at **${draft.time}** for **${draft.service}** (${dur}m). Reply CHANGE to try a different time.`,
      };
    }

    const lines = options
      .map((o, idx) => `${idx + 1}) ${o.time} with ${o.stylist_name}`)
      .join("\n");

    // Store the options in draft so n8n/reducer can handle "1/2/3" selection next
    draft.alt_options = options; // [{time, stylist_id, stylist_name, calendar_id}]
    draft.booking_status = "offering_alts";
    await saveDraft(from, draft);

    return {
      draft,
      reply:
        `No one is free at **${draft.time}** for **${draft.service}** (${dur}m).\n` +
        `Next options:\n${lines}\n\nReply 1, 2, or 3.`,
    };
  }
  // -------------------------------------------------------------------------------

  // Fairness selection for requested slot
  const withUtil = await Promise.all(
    free.map(async (s) => ({ s, util: await getUtil(draft.date, s.stylist_id) }))
  );

  const chosen = pickFairStylistForSlot(withUtil);

  draft.stylist_id = chosen.stylist_id;
  draft.stylist_name = chosenStylist?.name || null;
  draft.calendar_id = chosen.calendar_id;

  // Create 5-minute hold
  const booking_ref = draft.booking_ref || makeBookingRef();
  draft.booking_ref = booking_ref;
  
  // --- Build human-visible summary (shows in Google Calendar list) ---
  const stylistId = draft.stylist_id;                // e.g. "sty_01"
  const stylistName = chosenStylist?.name || "";     // e.g. "Maria" (use your actual variable name)

  // Example output: "Braids — Tatenda — Maria (sty_01)"
  const summary =
    `${draft.service} — ${draft.first_name || "Guest"}` +
    (stylistName ? ` — ${stylistName}` : "") +
    (stylistId ? ` (${stylistId})` : "");

  // --- Machine-readable metadata (for wipes/admin/tools) ---
  const privateProps = {
    source: "salon-bot",
    booking_ref: draft.booking_ref,
    stylist_id: stylistId || "",
    stylist_name: stylistName || "",
    service: draft.service || "",
    wa_from: draft.from || "",
  };

  // Keep your existing description (or use this pattern)
  const description =
    `Booked via WhatsApp\n` +
    `booking_ref=${draft.booking_ref}\n` +
    `stylist_id=${stylistId || ""}\n` +
    `service=${draft.service || ""}\n` +
    `source=salon-bot\n` +
    `from=${draft.from || ""}`;

  // Create hold event (tentative)
  const ev = await createHoldEvent(draft.calendar_id, {
    startISO,
    endISO,
    timeZone: draft.tz,
    summary,
    description,
    privateProps,
  });

  // Save hold details
  draft.hold_event_id = ev.id;
  draft.hold_expires_at = Date.now() + 5 * 60 * 1000;
  draft.booking_status = "awaiting_confirm";
  draft.hold_idempotency_key = draft.idempotency_key;

  // Clear any old alt options once we have a hold
  draft.alt_options = null;

  await saveDraft(from, draft);

  return {
    draft,
    reply: `I can hold **${draft.service}** on **${draft.date} ${draft.time}** with **${chosen.name}** for 5 minutes. Reply **CONFIRM** to book or **CHANGE** for other times.`,
  };
}