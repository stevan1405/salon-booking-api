import "dotenv/config";
import express from "express";
import { getAuthUrl, getOAuthClient, saveToken } from "./calendar/googleAuth.js";
import { phase3Handle } from "./phase3.js";
import { phase3Confirm } from "./phase3Confirm.js";
import { phase3Change } from "./phase3Change.js";
import { phase3PickAlt } from "./phase3PickAlt.js";
import { phase3Cancel } from "./phase3Cancel.js";
import { phase3CancelByRef } from "./phase3CancelByRef.js";
import { phase3RescheduleByRef } from "./phase3RescheduleByRef.js";

const app = express();   // 🔥 THIS WAS MISSING
app.use(express.json());

// Health route
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send('OK. Try /health or /auth');
});

// OAuth start
//app.get("/auth", (req, res) => {
//  res.redirect(getAuthUrl());
//});

app.get("/auth", (req, res) => {
  try {
    const url = getAuthUrl();
    return res.redirect(url);
  } catch (e) {
    console.error("[/auth] failed:", e?.stack || e);
    return res.status(500).send(`Auth setup error: ${String(e?.message || e)}`);
  }
});

// OAuth callback
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");
    await handleOAuthCallback(code);
    res.send("Google Calendar authorized. You can close this tab.");
  } catch (e) {
    console.error("[/oauth2callback] failed:", e?.stack || e);
    res.status(500).send(String(e?.message || e));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

app.post("/phase3", async (req, res) => {
  try {
    const { from, extracted } = req.body;
    const out = await phase3Handle({ from, extracted });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "phase3_failed", message: String(e?.message || e) });
  }
});

app.post("/phase3/confirm", async (req, res) => {
  try {
    const { from } = req.body;
    const out = await phase3Confirm({ from });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "confirm_failed", message: String(e?.message || e) });
  }
});

app.post("/phase3/change", async (req, res) => {
  try {
    const { from } = req.body;
    const out = await phase3Change({ from });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "change_failed", message: String(e?.message || e) });
  }
});

app.post("/phase3/pick", async (req, res) => {
  try {
    const { from, choice } = req.body; // choice = "1" | "2" | "3"
    const out = await phase3PickAlt({ from, choice });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "pick_failed", message: String(e?.message || e) });
  }
});

app.post("/phase3/cancel", async (req, res) => {
  try {
    const { from } = req.body;
    const out = await phase3Cancel({ from });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "cancel_failed", message: String(e?.message || e) });
  }
});

app.post("/phase3/cancel_by_ref", async (req, res) => {
  try {
    const { booking_ref } = req.body;
    const out = await phase3CancelByRef({ booking_ref });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "cancel_by_ref_failed", message: String(e?.message || e) });
  }
});

app.post("/phase3/reschedule_by_ref", async (req, res) => {
  try {
    const { booking_ref, new_date, new_time } = req.body;
    const out = await phase3RescheduleByRef({ booking_ref, new_date, new_time });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "reschedule_failed", message: String(e?.message || e) });
  }
});