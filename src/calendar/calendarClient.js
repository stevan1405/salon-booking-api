// src/calendar/calendarClient.js
import { google } from "googleapis";
import { getAuthorizedClient } from "./googleAuth.js";

export async function getCalendarClient() {
  const auth = await getAuthorizedClient();
  if (!auth) throw new Error("Google not authorized yet. Visit /auth first");
  return google.calendar({ version: "v3", auth });
}