import { airtableFetch } from "./client.js";

function baseTableUrl(tableName, params = {}) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) throw new Error("Missing AIRTABLE_BASE_ID");

  const qs = new URLSearchParams(params);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return `/v0/${baseId}/${encodeURIComponent(tableName)}${suffix}`;
}

export async function getActiveStylists() {
  // active = 1 in Airtable formula for checkbox true
  const data = await airtableFetch(
    baseTableUrl("Stylists", { filterByFormula: "{active}=1" })
  );

  return (data.records || []).map((r) => ({
    stylist_id: r.fields.stylist_id,
    name: r.fields.name,
    calendar_id: r.fields.calendar_id,
    working_hours_json: r.fields.working_hours_json || "{}",
  })).filter(s => s.stylist_id && s.calendar_id);
}

export async function getServiceDurationMin(serviceNameOrId) {
  // MVP: match on Services.name equals service string (case-insensitive-ish via FIND)
  const formula = `FIND(LOWER("${serviceNameOrId}"), LOWER({name})) > 0`;
  const data = await airtableFetch(baseTableUrl("Services", { filterByFormula: formula }));

  const rec = data.records?.[0];
  if (!rec) return null;

  const dur = rec.fields.duration_min;
  return typeof dur === "number" ? dur : null;
}