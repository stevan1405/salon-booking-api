import { google } from "googleapis";
import fs from "node:fs";

const TOKEN_PATH = "./.gcal-token.json";

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl() {
  const oAuth2Client = getOAuthClient();
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });
}

export function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

export function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

export function getAuthedClientOrNull() {
  const token = loadToken();
  if (!token) return null;

  const oAuth2Client = getOAuthClient();
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}