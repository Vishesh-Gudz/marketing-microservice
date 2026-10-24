import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { SYNC_CADENCE } from "./sync/config";
import { RECOVERY_INTERVAL_MINUTES } from "./whatsapp/config";

const crons = cronJobs();

// Phase 4: expire OAuth states, mark expired tokens needs_reauth, delete revoked credentials.
crons.hourly(
  "connection health sweep",
  { minuteUTC: 7 },
  internal.connections.maintenance.sweep,
  {},
);

// Phase 10: refresh long-lived Instagram tokens before they expire (ciphertext replaced
// atomically; failures move the connection to needs_reauth or record a sanitized error).
crons.daily(
  "instagram token refresh",
  { hourUTC: 3, minuteUTC: 17 },
  internal.connections.tokenRefresh.refreshExpiringTokens,
  {},
);

// Phase 5: sync planner. Plans due accounts (bounded batches); workers do the I/O.
crons.interval(
  "sync planner",
  { minutes: SYNC_CADENCE.plannerIntervalMinutes },
  internal.sync.planner.tick,
  {},
);

// WhatsApp (ADR 0013): retry webhook events stuck in processing one by one; repeated failures
// become `failed` for an admin to requeue.
crons.interval(
  "whatsapp stuck event recovery",
  { minutes: RECOVERY_INTERVAL_MINUTES },
  internal.whatsapp.recovery.recoverStuckEvents,
  {},
);

// WhatsApp: delete webhook events no longer pending 30 days after receipt (bounded batches).
// Never deletes pending events, events with a queued retry, messages or conversations.
crons.hourly(
  "whatsapp event retention",
  { minuteUTC: 37 },
  internal.whatsapp.retention.purgeExpiredEvents,
  {},
);

export default crons;
