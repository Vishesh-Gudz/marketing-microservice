import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Phase 4: expire OAuth states, mark expired tokens needs_reauth, delete revoked credentials.
crons.hourly(
  "connection health sweep",
  { minuteUTC: 7 },
  internal.connections.maintenance.sweep,
  {},
);

export default crons;
