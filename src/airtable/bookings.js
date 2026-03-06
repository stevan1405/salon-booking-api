import { airtableCreateRecord } from "./records.js";

export async function createBookingRecord({
  booking_ref,
  customer_name: first_name,   // NEW
  first_name,                  // keep for compatibility
  wa_from,
  service_id,   // for MVP, we’ll store service name here
  stylist_id,
  stylist_name,                // NEW
  start_iso,
  end_iso,
  status,
  gcal_event_id,
}) {
  // Your bootstrap used text fields for start/end in Bookings (safe).
  // So store ISO strings.
  return airtableCreateRecord("Bookings", {
    booking_ref,
    first_name,
    wa_from,
    service_id,
    stylist_id,
    start_iso,
    end_iso,
    status,
    gcal_event_id,
  });
}