import { airtableFetch } from "./client.js";

export async function airtableCreateRecord(tableName, fields) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) throw new Error("Missing AIRTABLE_BASE_ID");

  return airtableFetch(`/v0/${baseId}/${encodeURIComponent(tableName)}`, {
    method: "POST",
    body: { fields },
  });
}

export async function airtableListRecords(tableName, { filterByFormula } = {}) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) throw new Error("Missing AIRTABLE_BASE_ID");

  const params = new URLSearchParams();
  if (filterByFormula) params.set("filterByFormula", filterByFormula);

  const path = `/v0/${baseId}/${encodeURIComponent(tableName)}?${params.toString()}`;
  return airtableFetch(path);
}