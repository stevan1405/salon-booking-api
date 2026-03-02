// src/redis.js
import Redis from "ioredis";

const url = process.env.REDIS_URL;
if (!url) throw new Error("Missing REDIS_URL");

export const redis = new Redis(url);

redis.on("connect", () => console.log("[redis] connected"));
redis.on("error", (err) => console.error("[redis] error:", err.message));

// ---------- Draft storage ----------
export async function loadDraft(from) {
  const key = `draft:${from}`;
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : {};
}

export async function saveDraft(from, draft, ttlSec = 60 * 60) {
  const key = `draft:${from}`;
  await redis.set(key, JSON.stringify(draft), "EX", ttlSec);
}

// ---------- Fairness counters ----------
function utilKey(dateYYYYMMDD, stylistId) {
  return `util:${dateYYYYMMDD}:${stylistId}`;
}

export async function getUtil(dateYYYYMMDD, stylistId) {
  const raw = await redis.get(utilKey(dateYYYYMMDD, stylistId));
  return raw ? JSON.parse(raw) : { booked_minutes: 0, appt_count: 0 };
}

export async function incrUtil(dateYYYYMMDD, stylistId, durationMin) {
  const current = await getUtil(dateYYYYMMDD, stylistId);
  const next = {
    booked_minutes: (current.booked_minutes || 0) + durationMin,
    appt_count: (current.appt_count || 0) + 1,
  };
  await redis.set(utilKey(dateYYYYMMDD, stylistId), JSON.stringify(next), "EX", 60 * 60 * 48);
  return next;
}

export async function decrUtil(dateYYYYMMDD, stylistId, durationMin) {
  const current = await getUtil(dateYYYYMMDD, stylistId);
  const next = {
    booked_minutes: Math.max(0, (current.booked_minutes || 0) - durationMin),
    appt_count: Math.max(0, (current.appt_count || 0) - 1),
  };
  await redis.set(utilKey(dateYYYYMMDD, stylistId), JSON.stringify(next), "EX", 60 * 60 * 48);
  return next;
}