import { defineSchema } from "convex/server";
import { adTables } from "./tables/ads";
import { analyticsTables } from "./tables/analytics";
import { connectionTables } from "./tables/connections";
import { inboxTables } from "./tables/inbox";
import { instagramDataDeletionTables } from "./tables/instagramDataDeletion";
import { instagramMessagingTables } from "./tables/instagramMessaging";
import { maintenanceTables } from "./tables/maintenance";
import { metricTables } from "./tables/metrics";
import { socialTables } from "./tables/social";
import { syncTables } from "./tables/sync";
import { tenancyTables } from "./tables/tenancy";
import { whatsappTables } from "./tables/whatsapp";

// Conventions (enforced by convex/schema.test.ts):
// - Every table except the global integrationApps/organizations/fxRates (and Meta's
//   Instagram data-deletion requests, which name a user rather than a tenant, and the system
//   sweeps' cursors) carries `orgId`,
//   and every index on those tables starts with `orgId`, except the approved global
//   system indexes listed and justified in convex/schema.test.ts.
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
  ...whatsappTables,
  ...instagramMessagingTables,
  ...instagramDataDeletionTables,
  ...maintenanceTables,
  ...inboxTables,
});
