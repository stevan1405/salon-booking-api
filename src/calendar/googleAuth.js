// src/calendar/googleAuth.js
import { google } from "googleapis";
import { getRedis } from "../redis.js";

const TOKEN_KEY = process.env.GCAL_TOKEN_KEY || "gcal:token";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export function getOAuthClient() {
  const clientId = must("GOOGLE_CLIENT_ID");
  const clientSecret = must("GOOGLE_CLIENT_SECRET");
  const redirectUri = must("GOOGLE_REDIRECT_URI");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function loadToken() {
  const r = getRedis();
  if (!r) return null;
  const raw = await r.get(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveToken(token) {
  const r = getRedis();
  if (!r) throw new Error("Redis not configured (missing REDIS_URL)");
  await r.set(TOKEN_KEY, JSON.stringify(token));
  return true;
}

// ✅ This is what googleCalendar.js calls
export async function getAuthorizedClient() {
  const oAuth2Client = getOAuthClient();
  const token = await loadToken();
  if (!token) return null;
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

// ✅ This is what /auth route uses
export function getAuthUrl() {
  const oAuth2Client = getOAuthClient();
  const scopes = ["https://www.googleapis.com/auth/calendar"];

  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });
}

// ✅ This is what your callback route should call
export async function handleOAuthCallback(code) {
  const oAuth2Client = getOAuthClient();
  const { tokens } = await oAuth2Client.getToken(code);
  await saveToken(tokens);
  return tokens;
}