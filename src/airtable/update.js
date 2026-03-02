// src/airtable/update.js
import { airtableFetch } from "./client.js";

export async function airtableUpdateRecord(tableName, recordId, fields) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) throw new Error("Missing AIRTABLE_BASE_ID");

  return airtableFetch(`/v0/${baseId}/${encodeURIComponent(tableName)}/${recordId}`, {
    method: "PATCH",
    body: { fields },
  });
}