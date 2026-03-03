// src/redis.js
import Redis from "ioredis";

let _redis = null;

export function getRedis() {
  if (_redis) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    // Don't crash the whole server at startup
    console.error("[redis] Missing REDIS_URL (set it in the salon-booking-api service variables)");
    return null;
  }

  _redis = new Redis(url);

  _redis.on("connect", () => console.log("[redis] connected"));
  _redis.on("error", (err) => console.error("[redis] error:", err.message));

  return _redis;
}

// ---------- Draft storage ----------
export async function loadDraft(from) {
  const r = getRedis();
  if (!r) return {};
  const key = `draft:${from}`;
  const raw = await r.get(key);
  return raw ? JSON.parse(raw) : {};
}

export async function saveDraft(from, draft, ttlSec = 60 * 60) {
  const r = getRedis();
  if (!r) return;
  const key = `draft:${from}`;
  await r.set(key, JSON.stringify(draft), "EX", ttlSec);
}

// ---------- Fairness counters ----------
function utilKey(dateYYYYMMDD, stylistId) {
  return `util:${dateYYYYMMDD}:${stylistId}`;
}

export async function getUtil(dateYYYYMMDD, stylistId) {
  const r = getRedis();
  if (!r) return { booked_minutes: 0, appt_count: 0 };
  const raw = await r.get(utilKey(dateYYYYMMDD, stylistId));
  return raw ? JSON.parse(raw) : { booked_minutes: 0, appt_count: 0 };
}

export async function incrUtil(dateYYYYMMDD, stylistId, durationMin) {
  const r = getRedis();
  if (!r) return { booked_minutes: 0, appt_count: 0 };
  const current = await getUtil(dateYYYYMMDD, stylistId);
  const next = {
    booked_minutes: (current.booked_minutes || 0) + durationMin,
    appt_count: (current.appt_count || 0) + 1,
  };
  await r.set(utilKey(dateYYYYMMDD, stylistId), JSON.stringify(next), "EX", 60 * 60 * 48);
  return next;
}

export async function decrUtil(dateYYYYMMDD, stylistId, durationMin) {
  const r = getRedis();
  if (!r) return { booked_minutes: 0, appt_count: 0 };
  const current = await getUtil(dateYYYYMMDD, stylistId);
  const next = {
    booked_minutes: Math.max(0, (current.booked_minutes || 0) - durationMin),
    appt_count: Math.max(0, (current.appt_count || 0) - 1),
  };
  await r.set(utilKey(dateYYYYMMDD, stylistId), JSON.stringify(next), "EX", 60 * 60 * 48);
  return next;
}