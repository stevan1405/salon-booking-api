// src/airtable/find.js
import { airtableFetch } from "./client.js";

export async function airtableFindByFormula(tableName, filterByFormula) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) throw new Error("Missing AIRTABLE_BASE_ID");

  const qs = new URLSearchParams({ filterByFormula, maxRecords: "1" });
  const path = `/v0/${baseId}/${encodeURIComponent(tableName)}?${qs.toString()}`;
  return airtableFetch(path);
}