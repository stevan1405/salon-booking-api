// src/airtable/bookings.js
import { airtableFetch } from "./client.js";

const BASE_ID = process.env.AIRTABLE_BASE_ID;

function encTable(name) {
  return encodeURIComponent(name);
}

export async function createBookingRecord({
  booking_ref,
  customer_name,
  first_name,
  wa_from,
  service_id,
  stylist_id,
  stylist_name,
  start_iso,
  end_iso,
  status,
  gcal_event_id,
}) {
  if (!BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

  const customerName = customer_name || first_name || "";

  const body = {
    fields: {
      booking_ref,
      customer_name: customerName, // NEW preferred field
      first_name: customerName,    // keep for backward compatibility
      wa_from,
      service_id,
      stylist_id,
      stylist_name,
      start_iso,
      end_iso,
      status,
      gcal_event_id,
    },
  };

  return airtableFetch(`/v0/${BASE_ID}/${encTable("Bookings")}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}