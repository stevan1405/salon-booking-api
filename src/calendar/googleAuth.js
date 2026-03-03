// src/calendar/googleAuth.js
import { google } from "googleapis";
import { redis } from "../redis.js";

const TOKEN_KEY = process.env.GCAL_TOKEN_KEY || "gcal:token";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export function getOAuthClient() {
  const clientId = must("GOOGLE_CLIENT_ID");
  const clientSecret = must("GOOGLE_CLIENT_SECRET");
  const redirectUri = must("GOOGLE_REDIRECT_URI"); // must match Google Cloud redirect URIs

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function loadToken() {
  const raw = await redis.get(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveToken(token) {
  if (!token) throw new Error("saveToken called with empty token");
  await redis.set(TOKEN_KEY, JSON.stringify(token));
  return true;
}

export async function getAuthorizedClient() {
  const oAuth2Client = getOAuthClient();
  const token = await loadToken();
  if (!token) return null;
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

export function getAuthUrl() {
  const oAuth2Client = getOAuthClient();

  // keep scopes minimal for your use case
  const scopes = ["https://www.googleapis.com/auth/calendar"];

  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensures refresh_token is issued (important!)
    scope: scopes,
  });
}

/**
 * Exchange code -> token and store in Redis
 */
export async function handleOAuthCallback(code) {
  const oAuth2Client = getOAuthClient();
  const { tokens } = await oAuth2Client.getToken(code);

  // tokens should include refresh_token on first consent
  await saveToken(tokens);

  oAuth2Client.setCredentials(tokens);
  return tokens;
}