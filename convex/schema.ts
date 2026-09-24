import { defineSchema } from "convex/server";
import { adTables } from "./tables/ads";
import { connectionTables } from "./tables/connections";
import { metricTables } from "./tables/metrics";
import { socialTables } from "./tables/social";
import { tenancyTables } from "./tables/tenancy";

// Conventions (enforced by convex/schema.test.ts):
// - Every table except the global integrationApps/organizations carries `orgId`,
//   and every index on those tables starts with `orgId` (three approved global
//   system indexes in tables/connections.ts are the only exceptions).
// - Money fields (*Micros) are int64 micros; calendar dates are "YYYY-MM-DD" strings.
// Tables for later phases (connections, sync, rollups, inbox, alerts) are added
// by the phase that writes them. See docs/data-model.md.
export default defineSchema({
  ...tenancyTables,
  ...adTables,
  ...metricTables,
  ...socialTables,
  ...connectionTables,
});
