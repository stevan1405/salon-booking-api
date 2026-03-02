import "dotenv/config";
import { bootstrapAirtableBase } from "../src/airtable/bootstrap.js";

const out = await bootstrapAirtableBase();
console.log("Created Airtable base:", out.id);
console.log("Save AIRTABLE_BASE_ID=", out.id);