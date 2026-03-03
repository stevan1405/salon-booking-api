// src/calendar/googleCalendar.js
import { google } from "googleapis";
import { getAuthorizedClient } from "./googleAuth.js";

async function calendarClient() {
  const auth = await getAuthorizedClient();
  if (!auth) {
    throw new Error("Google not authorized yet. Visit /auth first");
  }
  return google.calendar({ version: "v3", auth });
}

// --- FreeBusy ---
export async function freeBusy(calendarIds, timeMinISO, timeMaxISO, timeZone) {
  const cal = await calendarClient();

  const resp = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      timeZone,
      items: calendarIds.map((id) => ({ id })),
    },
  });

  // resp.data.calendars is { [calendarId]: { busy: [{start,end}] } }
  return resp.data.calendars || {};
}

// --- Create hold event (tentative) ---
export async function createHoldEvent(calendarId, { startISO, endISO, timeZone, summary, description, privateProps }) {
  const cal = await calendarClient();

  const resp = await cal.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone },
      end: { dateTime: endISO, timeZone },
      status: "tentative",
      extendedProperties: {
        private: privateProps || {},
      },
    },
  });

  return resp.data;
}

// --- Confirm event (patch tentative -> confirmed) ---
export async function confirmEvent(calendarId, eventId) {
  const cal = await calendarClient();

  const resp = await cal.events.patch({
    calendarId,
    eventId,
    requestBody: { status: "confirmed" },
  });

  return resp.data;
}

// --- Delete event ---
export async function deleteEvent(calendarId, eventId) {
  const cal = await calendarClient();
  await cal.events.delete({ calendarId, eventId });
  return true;
}