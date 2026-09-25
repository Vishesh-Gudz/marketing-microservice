import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { SYNC_CADENCE } from "./sync/config";

const crons = cronJobs();

// Phase 4: expire OAuth states, mark expired tokens needs_reauth, delete revoked credentials.
crons.hourly(
  "connection health sweep",
  { minuteUTC: 7 },
  internal.connections.maintenance.sweep,
  {},
);

// Phase 5: sync planner. Plans due accounts (bounded batches); workers do the I/O.
crons.interval(
  "sync planner",
  { minutes: SYNC_CADENCE.plannerIntervalMinutes },
  internal.sync.planner.tick,
  {},
);

export default crons;
