// src/airtable/bookingsRead.js
import { airtableFindByFormula } from "./find.js";

export async function findBookingByRef(bookingRef) {
  if (!bookingRef) return null;
  const formula = `{booking_ref}="${bookingRef}"`;
  const data = await airtableFindByFormula("Bookings", formula);
  const rec = (data.records || [])[0];
  if (!rec) return null;
  return rec; // { id, fields }
}

export async function bookingExistsByRef(bookingRef) {
  return !!(await findBookingByRef(bookingRef));
}


/**
 * Find latest active booking by WhatsApp number.
 * Used for auto cancel/reschedule when user does not provide booking_ref.
 */
export async function findLatestActiveBookingByWaFrom(wa_from) {
  if (!wa_from) return null;

  const formula = `
    AND(
      {wa_from}="${wa_from}",
      OR(
        {status}="confirmed",
        {status}="awaiting_confirm"
      )
    )
  `;

  const data = await airtableFindByFormula(
    "Bookings",
    formula,
    {
      sort: [{ field: "start_iso", direction: "asc" }],
      maxRecords: 3
    }
  );

  const records = data.records || [];

  if (records.length === 0) return null;

  // return the soonest upcoming booking
  return records[0];
}