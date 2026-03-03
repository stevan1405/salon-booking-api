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
    const { date, stylist_id } = req.query;
    if (!date) return res.status(400).json({ error: "missing_date" });

    // If stylist_id provided, return only that
    if (stylist_id) {
      const util = await getUtil(date, String(stylist_id));
      return res.json({ ok: true, date, stylist_id, util });
    }

    // Otherwise, pull stylists from Airtable and return util for each
    const params = new URLSearchParams();
    params.set("pageSize", "100");
    const url = `/v0/${baseId()}/${encTable("Stylists")}?${params.toString()}`;
    const data = await airtableFetch(url, { method: "GET" });

    const stylists = (data.records || []).map((r) => ({
      id: r.id,
      ...r.fields,
    }));

    const rows = [];
    for (const s of stylists) {
      const sid = s.stylist_id;
      if (!sid) continue;
      const util = await getUtil(date, sid);
      rows.push({
        stylist_id: sid,
        name: s.name,
        booked_minutes: util.booked_minutes || 0,
        appt_count: util.appt_count || 0,
      });
    }

    rows.sort((a, b) => (a.booked_minutes - b.booked_minutes) || (a.appt_count - b.appt_count));

    res.json({ ok: true, date, util: rows });
  } catch (e) {
    console.error("[admin/util]", e);
    res.status(500).json({ error: "admin_util_failed", message: String(e?.message || e) });
  }
});