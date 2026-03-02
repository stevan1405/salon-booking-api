// src/airtable/stylistsRead.js
import { airtableFindByFormula } from "./find.js";

export async function findStylistById(stylistId) {
  if (!stylistId) return null;
  const formula = `{stylist_id}="${stylistId}"`;
  const data = await airtableFindByFormula("Stylists", formula);
  return (data.records || [])[0] || null; // { id, fields }
}