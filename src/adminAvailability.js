// src/adminAvailability.js
import express from "express";
import { DateTime } from "luxon";

import { getActiveStylists, getServiceDurationMin } from "./airtable/read.js";
import { getUtil } from "./redis.js";
import { isWithinWorkingHours } from "./calendar/workingHours.js";
import { freeBusy } from "./calendar/googleCalendar.js";

export const adminAvailabilityRouter = express.Router();

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(500).json({ error: "admin_not_configured" });

  const got = req.headers["x-admin-key"];
  if (!got || got !== expected) return res.status(401).json({ error: "unauthorized" });

  next();
}

adminAvailabilityRouter.use(requireAdmin);

function normalizeHHmm(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return s;
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = String(m[2] ?? "00").padStart(2, "0");
  return `${hh}:${mm}`;
}

function makeLocalDT(dateYYYYMMDD, timeHHmm, tz) {
  const zone = tz || "Africa/Harare";
  const t = normalizeHHmm(timeHHmm);
  const dt = DateTime.fromISO(`${dateYYYYMMDD}T${t}`, { zone });
  if (!dt.isValid) {
    throw new Error(`Invalid local datetime: ${dateYYYYMMDD} ${timeHHmm} (${zone})`);
  }
  return dt;
}

function toHHmmDT(dt) {
  return dt.toFormat("HH:mm");
}

function toUtcISO(dt) {
  return dt.toUTC().toISO();
}

function sortByFairness(rows) {
  return [...rows].sort((a, b) => {
    const am = a.util?.booked_minutes || 0;
    const bm = b.util?.booked_minutes || 0;
    if (am !== bm) return am - bm;

    const ac = a.util?.appt_count || 0;
    const bc = b.util?.appt_count || 0;
    if (ac !== bc) return ac - bc;

    return String(a.stylist_id || "").localeCompare(String(b.stylist_id || ""));
  });
}

adminAvailabilityRouter.get("/availability", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    const time = normalizeHHmm(req.query.time);
    const service = String(req.query.service || "");
    const stylistName = req.query.stylist_name ? String(req.query.stylist_name) : null;
    const tz = String(req.query.tz || "Africa/Harare");

    if (!date || !time || !service) {
      return res.status(400).json({
        error: "missing_params",
        message: "Required: date, time, service",
      });
    }

    const duration = (await getServiceDurationMin(service)) ?? 60;

    const startLocal = makeLocalDT(date, time, tz);
    const endLocal = startLocal.plus({ minutes: Number(duration) });

    const startHHmm = toHHmmDT(startLocal);
    const endHHmm = toHHmmDT(endLocal);
    const startISO = toUtcISO(startLocal);
    const endISO = toUtcISO(endLocal);

    const allStylists = await getActiveStylists();

    let preferredStylists = allStylists;
    let preference = "any";

    if (stylistName) {
      const sn = stylistName.toLowerCase();
      const match = allStylists.filter((s) =>
        String(s.name || "").toLowerCase().includes(sn)
      );
      if (match.length) {
        preferredStylists = match;
        preference = "specific";
      }
    }

    const evaluated = preferredStylists.map((s) => {
      const withinHours = isWithinWorkingHours(
        s.working_hours_json,
        date,
        startHHmm,
        endHHmm
      );

      return {
        stylist_id: s.stylist_id,
        stylist_name: s.name,
        calendar_id: s.calendar_id,
        within_hours: withinHours,
        reason: withinHours ? null : "outside_working_hours",
      };
    });

    const eligible = evaluated.filter((s) => s.within_hours);

    if (!eligible.length) {
      return res.json({
        ok: true,
        request: {
          date,
          time,
          service,
          duration_min: duration,
          tz,
          preference,
        },
        requested_slot: {
          start_local: startLocal.toISO(),
          end_local: endLocal.toISO(),
          start_iso: startISO,
          end_iso: endISO,
        },
        eligible_count: 0,
        free_count: 0,
        chosen: null,
        eligible: [],
        free: [],
        blocked: evaluated,
      });
    }

    const fb = await freeBusy(
      eligible.map((s) => s.calendar_id),
      startISO,
      endISO,
      tz
    );

    const busyOrFree = eligible.map((s) => {
      const cal = fb[s.calendar_id];
      const busy = cal?.busy || [];
      return {
        ...s,
        busy,
        is_free: busy.length === 0,
      };
    });

    const free = busyOrFree.filter((s) => s.is_free);
    const busy = busyOrFree
      .filter((s) => !s.is_free)
      .map((s) => ({ ...s, reason: "calendar_busy" }));

    const withUtil = await Promise.all(
      free.map(async (s) => ({
        stylist_id: s.stylist_id,
        stylist_name: s.stylist_name,
        calendar_id: s.calendar_id,
        util: await getUtil(date, s.stylist_id),
      }))
    );

    const fairness = sortByFairness(withUtil);
    const chosen = fairness[0] || null;

    return res.json({
      ok: true,
      request: {
        date,
        time,
        service,
        duration_min: duration,
        tz,
        preference,
      },
      requested_slot: {
        start_local: startLocal.toISO(),
        end_local: endLocal.toISO(),
        start_iso: startISO,
        end_iso: endISO,
      },
      eligible_count: eligible.length,
      free_count: free.length,
      chosen,
      fairness,
      eligible,
      free,
      blocked: [
        ...evaluated.filter((s) => !s.within_hours),
        ...busy,
      ],
    });
  } catch (e) {
    console.error("[admin/availability]", e);
    res.status(500).json({
      error: "admin_availability_failed",
      message: String(e?.message || e),
    });
  }
});