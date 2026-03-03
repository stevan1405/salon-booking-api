// src/admin.js
import express from "express";
import { airtableFetch } from "./airtable/client.js";
import { getUtil } from "./redis.js";

export const adminRouter = express.Router();

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(500).json({ error: "admin_not_configured" });

  const got = req.headers["x-admin-key"];
  if (!got || got !== expected) return res.status(401).json({ error: "unauthorized" });

  next();
}

adminRouter.use(requireAdmin);

// --- helpers ---
function baseId() {
  const id = process.env.AIRTABLE_BASE_ID;
  if (!id) throw new Error("Missing AIRTABLE_BASE_ID");
  return id;
}

function encTable(name) {
  return encodeURIComponent(name);
}

function encodeFormula(s) {
  return s;
}

// --- timezone formatting (for admin display) ---
const SALON_TZ = process.env.SALON_TZ || "Africa/Harare";

const fmtDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: SALON_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const fmtTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: SALON_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const localDate = (iso) => (iso ? fmtDate.format(new Date(iso)) : null);
const localTime = (iso) => (iso ? fmtTime.format(new Date(iso)) : null);

// Convert a salon-local YYYY-MM-DD to a UTC [start,end) ISO window.
// For Africa/Harare (UTC+2, no DST), local midnight = 22:00Z previous day.
function dayRangeUtc(dateYYYYMMDD, tz = SALON_TZ) {
  const [y, m, d] = String(dateYYYYMMDD).split("-").map(Number);
  if (!y || !m || !d) throw new Error("Invalid date (expected YYYY-MM-DD)");

  // If you later support DST timezones, switch to luxon.
  if (tz === "Africa/Harare") {
    const start = new Date(Date.UTC(y, m - 1, d, -2, 0, 0)); // local 00:00 -> UTC-2h
    const end = new Date(Date.UTC(y, m - 1, d + 1, -2, 0, 0));
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }

  // Fallback: treat as UTC day
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// --- 1) list bookings (by date, optional status) ---
adminRouter.get("/bookings", async (req, res) => {
  try {
    const { date, status, limit, offset } = req.query;

    // Airtable DateTime filtering: use a UTC window derived from salon-local day.
    const parts = [];

    if (date) {
      const { startIso, endIso } = dayRangeUtc(String(date), SALON_TZ);
      parts.push(`AND(IS_AFTER({start_iso},"${startIso}"),IS_BEFORE({start_iso},"${endIso}"))`);
    }

    if (status) {
      parts.push(`{status}="${status}"`);
    }

    const filterByFormula =
      parts.length === 0 ? null : parts.length === 1 ? parts[0] : `AND(${parts.join(",")})`;

    const params = new URLSearchParams();
    if (filterByFormula) params.set("filterByFormula", encodeFormula(filterByFormula));
    params.set("pageSize", String(Math.min(Number(limit || 50), 100)));
    if (offset) params.set("offset", String(offset));
    params.set("sort[0][field]", "start_iso");
    params.set("sort[0][direction]", "asc");

    const url = `/v0/${baseId()}/${encTable("Bookings")}?${params.toString()}`;
    const data = await airtableFetch(url, { method: "GET" });

    const bookings = (data.records || []).map((r) => {
      const f = r.fields || {};
      return {
        id: r.id,
        ...f,

        // salon-local display fields (Google Calendar style)
        start_local_date: localDate(f.start_iso),
        start_local_time: localTime(f.start_iso),
        end_local_time: localTime(f.end_iso),
        tz: SALON_TZ,
      };
    });

    res.json({
      ok: true,
      filter: { date: date || null, status: status || null },
      next_offset: data.offset || null,
      bookings,
    });
  } catch (e) {
    console.error("[admin/bookings]", e);
    res.status(500).json({ error: "admin_list_failed", message: String(e?.message || e) });
  }
});

// --- 2) lookup booking by booking_ref ---
adminRouter.get("/booking/:booking_ref", async (req, res) => {
  try {
    const { booking_ref } = req.params;

    const formula = `{booking_ref}="${booking_ref}"`;
    const params = new URLSearchParams();
    params.set("filterByFormula", formula);
    params.set("maxRecords", "1");

    const url = `/v0/${baseId()}/${encTable("Bookings")}?${params.toString()}`;
    const data = await airtableFetch(url, { method: "GET" });

    const rec = (data.records || [])[0];
    if (!rec) return res.status(404).json({ error: "not_found" });

    const f = rec.fields || {};
    res.json({
      ok: true,
      booking: {
        id: rec.id,
        ...f,
        start_local_date: localDate(f.start_iso),
        start_local_time: localTime(f.start_iso),
        end_local_time: localTime(f.end_iso),
        tz: SALON_TZ,
      },
    });
  } catch (e) {
    console.error("[admin/booking/:ref]", e);
    res.status(500).json({ error: "admin_lookup_failed", message: String(e?.message || e) });
  }
});

// --- 3) util snapshot (Redis fairness counters) for a date ---
// returns both Airtable-based totals (authoritative) and Redis util (fairness cache)
adminRouter.get("/util", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    const stylistFilter = req.query.stylist_id ? String(req.query.stylist_id) : null;
    if (!date) return res.status(400).json({ error: "missing_date" });

    const tz = SALON_TZ;

    const fmtDateLocal = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const fmtTimeLocal = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const localDateOnly = (iso) => fmtDateLocal.format(new Date(iso)); // YYYY-MM-DD
    const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

    // 1) Load stylists (for names)
    const stylUrl = `/v0/${baseId()}/${encTable("Stylists")}?pageSize=100`;
    const stylData = await airtableFetch(stylUrl, { method: "GET" });
    const stylists = (stylData.records || []).map((r) => ({ id: r.id, ...r.fields }));

    const stylistById = new Map();
    for (const s of stylists) {
      if (s.stylist_id) stylistById.set(s.stylist_id, s);
    }

    // 2) Load confirmed bookings and aggregate by LOCAL date
    const params = new URLSearchParams();
    params.set("pageSize", "100");
    params.set("filterByFormula", `{status}="confirmed"`);
    params.set("sort[0][field]", "start_iso");
    params.set("sort[0][direction]", "asc");

    const bookUrl = `/v0/${baseId()}/${encTable("Bookings")}?${params.toString()}`;
    const bookData = await airtableFetch(bookUrl, { method: "GET" });
    const bookings = (bookData.records || []).map((r) => ({ id: r.id, ...r.fields }));

    const agg = new Map();

    for (const b of bookings) {
      if (!b.start_iso || !b.end_iso || !b.stylist_id) continue;
      if (stylistFilter && b.stylist_id !== stylistFilter) continue;

      if (localDateOnly(b.start_iso) !== date) continue;

      const dur = minutesBetween(b.start_iso, b.end_iso);
      if (!agg.has(b.stylist_id)) agg.set(b.stylist_id, { booked_minutes: 0, appt_count: 0, examples: [] });

      const row = agg.get(b.stylist_id);
      row.booked_minutes += dur;
      row.appt_count += 1;

      if (row.examples.length < 3) {
        row.examples.push({
          booking_ref: b.booking_ref,
          service: b.service_id,
          start_local: fmtTimeLocal.format(new Date(b.start_iso)),
          end_local: fmtTimeLocal.format(new Date(b.end_iso)),
        });
      }
    }

    // 3) Overlay Redis util (fairness cache)
    const airtable_util = [];
    const redis_util = [];

    const stylistIds = stylistFilter ? [stylistFilter] : Array.from(stylistById.keys());

    for (const sid of stylistIds) {
      const s = stylistById.get(sid) || {};
      const a = agg.get(sid) || { booked_minutes: 0, appt_count: 0, examples: [] };

      airtable_util.push({
        stylist_id: sid,
        name: s.name || null,
        booked_minutes: a.booked_minutes,
        appt_count: a.appt_count,
        examples: a.examples,
      });

      const r = await getUtil(date, sid);
      redis_util.push({
        stylist_id: sid,
        name: s.name || null,
        booked_minutes: r.booked_minutes || 0,
        appt_count: r.appt_count || 0,
      });
    }

    airtable_util.sort((a, b) => (a.booked_minutes - b.booked_minutes) || (a.appt_count - b.appt_count));
    redis_util.sort((a, b) => (a.booked_minutes - b.booked_minutes) || (a.appt_count - b.appt_count));

    res.json({
      ok: true,
      date,
      tz,
      airtable_util,
      redis_util,
      note: "airtable_util is authoritative reporting; redis_util is fairness cache.",
    });
  } catch (e) {
    console.error("[admin/util]", e);
    res.status(500).json({ error: "admin_util_failed", message: String(e?.message || e) });
  }
});