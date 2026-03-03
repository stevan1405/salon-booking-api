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
  // safest to rely on URLSearchParams in the request below, but keeping helper
  return s;
}

// --- 1) list bookings (by date, optional status) ---
adminRouter.get("/bookings", async (req, res) => {
  try {
    const { date, status, limit, offset } = req.query;

    // If date is provided, filter by date portion of start_iso (ISO string)
    // Example formula: LEFT({start_iso},10)='2026-03-03'
    const parts = [];
    if (date) parts.push(`LEFT({start_iso},10)="${date}"`);
    if (status) parts.push(`{status}="${status}"`);

    const filterByFormula = parts.length ? `AND(${parts.join(",")})` : null;

    const params = new URLSearchParams();
    if (filterByFormula) params.set("filterByFormula", encodeFormula(filterByFormula));
    params.set("pageSize", String(Math.min(Number(limit || 50), 100)));
    if (offset) params.set("offset", String(offset));
    // Sort newest first
    params.set("sort[0][field]", "start_iso");
    params.set("sort[0][direction]", "asc");

    const url = `/v0/${baseId()}/${encTable("Bookings")}?${params.toString()}`;
    const data = await airtableFetch(url, { method: "GET" });

    const bookings = (data.records || []).map((r) => ({
      id: r.id,
      ...r.fields,
    }));

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

    res.json({ ok: true, booking: { id: rec.id, ...rec.fields } });
  } catch (e) {
    console.error("[admin/booking/:ref]", e);
    res.status(500).json({ error: "admin_lookup_failed", message: String(e?.message || e) });
  }
});

// --- 3) util snapshot (Redis fairness counters) for a date ---
// requires you already store util:YYYY-MM-DD:sty_xx as JSON
adminRouter.get("/util", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    const stylistFilter = req.query.stylist_id ? String(req.query.stylist_id) : null;
    if (!date) return res.status(400).json({ error: "missing_date" });

    const tz = process.env.SALON_TZ || "Africa/Harare";

    // Helpers to format + compute in salon TZ
    const fmtDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const fmtTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const localDate = (iso) => fmtDate.format(new Date(iso)); // YYYY-MM-DD
    const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

    // 1) Load stylists (for names)
    const stylUrl = `/v0/${baseId()}/${encTable("Stylists")}?pageSize=100`;
    const stylData = await airtableFetch(stylUrl, { method: "GET" });
    const stylists = (stylData.records || []).map((r) => ({ id: r.id, ...r.fields }));

    const stylistById = new Map();
    for (const s of stylists) {
      if (s.stylist_id) stylistById.set(s.stylist_id, s);
    }

    // 2) Load bookings (confirmed only) and aggregate by stylist for the requested LOCAL date
    // We'll fetch a broad set and then filter locally by timezone date.
    const params = new URLSearchParams();
    params.set("pageSize", "100");
    params.set("filterByFormula", `{status}="confirmed"`); // reporting should reflect confirmed
    params.set("sort[0][field]", "start_iso");
    params.set("sort[0][direction]", "asc");

    const bookUrl = `/v0/${baseId()}/${encTable("Bookings")}?${params.toString()}`;
    const bookData = await airtableFetch(bookUrl, { method: "GET" });
    const bookings = (bookData.records || []).map((r) => ({ id: r.id, ...r.fields }));

    const agg = new Map(); // stylist_id -> {booked_minutes, appt_count, examples:[]}

    for (const b of bookings) {
      if (!b.start_iso || !b.end_iso || !b.stylist_id) continue;
      if (stylistFilter && b.stylist_id !== stylistFilter) continue;

      // Compare by LOCAL salon date (not UTC slice)
      if (localDate(b.start_iso) !== date) continue;

      const dur = minutesBetween(b.start_iso, b.end_iso);
      if (!agg.has(b.stylist_id)) agg.set(b.stylist_id, { booked_minutes: 0, appt_count: 0, examples: [] });

      const row = agg.get(b.stylist_id);
      row.booked_minutes += dur;
      row.appt_count += 1;

      // optional: include a couple examples with salon-local times
      if (row.examples.length < 3) {
        row.examples.push({
          booking_ref: b.booking_ref,
          service: b.service_id,
          start_local: fmtTime.format(new Date(b.start_iso)),
          end_local: fmtTime.format(new Date(b.end_iso)),
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