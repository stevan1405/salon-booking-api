import { airtableFetch } from "./client.js";

export async function bootstrapAirtableBase() {
  const workspaceId = process.env.AIRTABLE_WORKSPACE_ID;
  if (!workspaceId) throw new Error("Missing AIRTABLE_WORKSPACE_ID");

  const body = {
    name: "Salon Booking System",
    workspaceId,
    tables: [
      {
        name: "Stylists",
        fields: [
          { name: "stylist_id", type: "singleLineText" }, // primary field
          { name: "name", type: "singleLineText" },
          { name: "calendar_id", type: "singleLineText" },
          {
        name: "active",
        type: "checkbox",
          options: {
            icon: "check",
            color: "greenBright"
            }
            },
          { name: "working_hours_json", type: "multilineText" },
        ],
      },
      {
        name: "Services",
        fields: [
          { name: "service_id", type: "singleLineText" }, // primary
          { name: "name", type: "singleLineText" },
          { name: "duration_min", type: "number", options: { precision: 0 } },
        ],
      },
      {
        name: "Bookings",
        fields: [
          { name: "booking_ref", type: "singleLineText" }, // primary
          { name: "first_name", type: "singleLineText" },
          { name: "wa_from", type: "phoneNumber" },
          { name: "service_id", type: "singleLineText" },
          { name: "stylist_id", type: "singleLineText" },
          { name: "start_iso", type: "singleLineText" },
          { name: "end_iso", type: "singleLineText" },
          {
            name: "status",
            type: "singleSelect",
            options: { choices: [{ name: "hold" }, { name: "confirmed" }, { name: "cancelled" }] },
          },
          { name: "gcal_event_id", type: "singleLineText" },
        ],
      },
    ],
  };

  // Create base + tables in one request
  const created = await airtableFetch("/v0/meta/bases", { method: "POST", body });
  return created; // contains id and schema
}