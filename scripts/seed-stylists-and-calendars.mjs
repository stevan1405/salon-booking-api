import "dotenv/config";
import { createSecondaryCalendar } from "../src/calendar/googleCalendar.js";
import { airtableCreateRecord } from "../src/airtable/records.js";

const TZ = "Africa/Harare";

const STYLISTS = [
  { stylist_id: "sty_01", name: "Maria" },
  { stylist_id: "sty_02", name: "Tanya" },
  { stylist_id: "sty_03", name: "Brian" },
];

const DEFAULT_HOURS = JSON.stringify({
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "19:00" }],
  sat: [{ start: "09:00", end: "16:00" }],
  sun: [],
});

for (const s of STYLISTS) {
  const cal = await createSecondaryCalendar({
    summary: `Stylist – ${s.name}`,
    timeZone: TZ,
    description: `stylist_id=${s.stylist_id}`,
  });

  await airtableCreateRecord("Stylists", {
    stylist_id: s.stylist_id,
    name: s.name,
    calendar_id: cal.id,
    active: true,
    working_hours_json: DEFAULT_HOURS,
  });

  console.log("Created:", s.name, "calendar_id:", cal.id);
}