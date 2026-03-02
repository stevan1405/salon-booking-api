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