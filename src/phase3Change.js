// src/phase3Change.js
import { loadDraft, saveDraft } from "./redis.js";
import { deleteEvent } from "./calendar/googleCalendar.js";

export async function phase3Change({ from }) {
  const draft = await loadDraft(from);

  // If already booked, don't delete the confirmed booking here.
  // (If you want cancellations, create a separate /phase3/cancel flow.)
  if (draft.booking_status === "booked" && draft.event_id) {
    return {
      draft,
      reply: "This booking is already confirmed ✅. Reply RESCHEDULE to change it, or CANCEL to cancel it.",
    };
  }

  // If there's an active hold, delete it (best effort)
  if (draft.hold_event_id && draft.calendar_id) {
    try {
      await deleteEvent(draft.calendar_id, draft.hold_event_id);
    } catch {
      // best effort cleanup
    }
  }

  // Clear hold state
  draft.hold_event_id = null;
  draft.hold_expires_at = null;
  draft.hold_idempotency_key = null;

  // #4: clear event_id only if not booked
  if (draft.booking_status !== "booked") {
    draft.event_id = null;
  }

  // Return to draft mode
  draft.booking_status = "draft";

  await saveDraft(from, draft);

  return {
    draft,
    reply: "Sure — what time would you like instead? (You can also tell me a preferred stylist or reply ANY.)",
  };
}