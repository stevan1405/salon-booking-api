import "dotenv/config";
import { airtableCreateRecord } from "../src/airtable/records.js";

// Add only a few for MVP; expand later.
const SERVICES = [
  { service_id: "svc_haircut", name: "Haircut", duration_min: 45 },
  { service_id: "svc_blowdry", name: "Blowdry", duration_min: 30 },
  { service_id: "svc_braids", name: "Braids", duration_min: 120 },
];

for (const s of SERVICES) {
  await airtableCreateRecord("Services", s);
  console.log("Created service:", s.name);
}
