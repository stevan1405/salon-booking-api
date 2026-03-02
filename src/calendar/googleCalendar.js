import { google } from "googleapis";
import { getAuthedClientOrNull } from "./googleAuth.js";

export function getCalendarClient() {
  const auth = getAuthedClientOrNull();
  if (!auth) throw new Error("Google not authorized yet. Visit /auth first.");
  return google.calendar({ version: "v3", auth });
}

export async function freeBusy(calendarIds, timeMinISO, timeMaxISO, timeZone) {
  const calendar = getCalendarClient();
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      timeZone,
      items: calendarIds.map((id) => ({ id })),
    },
  });
  return res.data.calendars || {};
}

export async function createHoldEvent(calendarId, { startISO, endISO, timeZone, summary, description, privateProps }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      status: "tentative",
      summary,
      description,
      start: { dateTime: startISO, timeZone },
      end: { dateTime: endISO, timeZone },
      extendedProperties: {
        private: privateProps || {},
      },
    },
  });
  return res.data; // includes id
}

export async function confirmEvent(calendarId, eventId) {
  const calendar = getCalendarClient();
  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: { status: "confirmed" },
  });
  return res.data;
}

export async function deleteEvent(calendarId, eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId, eventId });
}