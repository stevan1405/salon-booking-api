// src/adminWipe.js
import express from "express";
import { airtableFetch } from "./airtable/client.js";
import { getCalendarClient } from "./calendar/calendarClient.js"; // we'll add this helper below

export const adminWipeRouter = express.Router();

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  const got = req.headers["x-admin-key"];
  if (!expected) return res.status(500).json({ error: "admin_not_configured" });
  if (!got || got !== expected) return res.status(401).json({ error: "unauthorized" });
  next();
}
adminWipeRouter.use(requireAdmin);

function baseId() {
  const id = process.env.AIRTABLE_BASE_ID;
  if (!id) throw new Error("Missing AIRTABLE_BASE_ID");
  return id;
}
function encTable(name) {
  return encodeURIComponent(name);
}

adminWipeRouter.post("/wipe/calendars", async (req, res) => {
  try {
    const { timeMin, timeMax, dryRun } = req.body || {};
    if (!timeMin || !timeMax) {
      return res.status(400).json({ error: "missing_timeMin_timeMax" });
    }

    const maxEvents = Math.min(Number(process.env.WIPE_MAX_EVENTS || 500), 2000);

    // 1) load stylists -> calendar ids
    const stylUrl = `/v0/${baseId()}/${encTable("Stylists")}?pageSize=100`;
    const stylData = await airtableFetch(stylUrl, { method: "GET" });
    const stylists = (stylData.records || []).map((r) => ({ id: r.id, ...r.fields }))
      .filter((s) => s.calendar_id);

    const cal = await getCalendarClient();

    const report = [];
    let totalDeleted = 0;

    for (const s of stylists) {
      const calendarId = s.calendar_id;
      const items = [];

      // list events in window
      let pageToken = null;
      do {
        const resp = await cal.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: Math.min(250, maxEvents),
          pageToken: pageToken || undefined,
        });
        const batch = resp.data.items || [];
        for (const ev of batch) {
          items.push({
            id: ev.id,
            summary: ev.summary,
            start: ev.start?.dateTime || ev.start?.date,
            end: ev.end?.dateTime || ev.end?.date,
          });
          if (items.length >= maxEvents) break;
        }
        pageToken = resp.data.nextPageToken;
      } while (pageToken && items.length < maxEvents);

      let deleted = 0;
      if (!dryRun) {
        for (const ev of items) {
          await cal.events.delete({ calendarId, eventId: ev.id });
          deleted++;
        }
      }

      totalDeleted += deleted;
      report.push({
        stylist_id: s.stylist_id,
        name: s.name,
        calendar_id: calendarId,
        found: items.length,
        deleted,
        sample: items.slice(0, 5),
      });
    }

    res.json({ ok: true, dryRun: !!dryRun, timeMin, timeMax, totalDeleted, report });
  } catch (e) {
    console.error("[admin wipe calendars]", e);
    res.status(500).json({ error: "wipe_failed", message: String(e?.message || e) });
  }
});