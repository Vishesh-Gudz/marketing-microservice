import { defineSchema } from "convex/server";
import { adTables } from "./tables/ads";
import { analyticsTables } from "./tables/analytics";
import { connectionTables } from "./tables/connections";
import { metricTables } from "./tables/metrics";
import { socialTables } from "./tables/social";
import { syncTables } from "./tables/sync";
import { tenancyTables } from "./tables/tenancy";

// Conventions (enforced by convex/schema.test.ts):
// - Every table except the global integrationApps/organizations/fxRates carries `orgId`,
//   and every index on those tables starts with `orgId` (four approved global
//   system indexes: three in tables/connections.ts, one in tables/sync.ts).
// - Money fields (*Micros) are int64 micros; calendar dates are "YYYY-MM-DD" strings.
// Tables for later phases (inbox, alerts) are added by the phase that writes
// them. See docs/data-model.md.
export default defineSchema({
  ...tenancyTables,
  ...adTables,
  ...metricTables,
  ...socialTables,
  ...connectionTables,
  ...syncTables,
  ...analyticsTables,
});
