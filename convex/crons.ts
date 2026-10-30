import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { RECOVERY_INTERVAL_MINUTES as INSTAGRAM_RECOVERY_INTERVAL_MINUTES } from "./instagram/messaging/config";
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

// Instagram messaging (ADR 0017): the same recovery and event retention as WhatsApp, for
// Instagram webhook events. Never touches conversations or messages.
crons.interval(
  "instagram stuck event recovery",
  { minutes: INSTAGRAM_RECOVERY_INTERVAL_MINUTES },
  internal.instagram.messaging.recovery.recoverStuckEvents,
  {},
);

crons.hourly(
  "instagram event retention",
  { minuteUTC: 41 },
  internal.instagram.messaging.retention.purgeExpiredEvents,
  {},
);

// Instagram messaging D14 (ADR 0017): start or resume the purge of turned-off accounts whose
// 30-day grace period ended (that account's events, messages and conversations only).
crons.hourly(
  "instagram messaging purge",
  { minuteUTC: 43 },
  internal.instagram.messaging.purge.sweepMessagingPurges,
  {},
);

// Meta's Instagram data-deletion requests (ADR 0017, IM6): resume requests no deletion step has
// advanced for 15 minutes (each step re-reads and deletes only its own org's rows).
crons.hourly(
  "instagram data deletion requests",
  { minuteUTC: 51 },
  internal.instagram.dataDeletion.requests.sweepDeletionRequests,
  {},
);

// YouTube retention (ADR 0016, Checkpoint 3b): resume interrupted channel purges and delete
// videos no listing has refreshed for 25 days, with their snapshots (bounded batches).
crons.hourly(
  "youtube retention sweep",
  { minuteUTC: 47 },
  internal.connections.youtubeRetention.sweepYouTubeRetention,
  {},
);

// YouTube retention: re-check channels whose authorization was last confirmed more than 25 days
// ago; only a confirmed failure purges (inconclusive checks are audited and retried daily).
crons.daily(
  "youtube authorization check",
  { hourUTC: 4, minuteUTC: 27 },
  internal.connections.youtubeRetention.planYouTubeAuthorizationChecks,
  {},
);

export default crons;
