import { query } from "./_generated/server";
import { v } from "convex/values";

export const SERVICE_NAME = "marketing-microservice";

/**
 * Liveness probe for the Convex deployment.
 *
 * Phase 0 only: exists so the toolchain (codegen, deploy, convex-test, the
 * dashboard's Convex client) has something real to exercise. From Phase 1,
 * public functions live under `convex/v1/` behind tenant-aware wrappers.
 */
export const ping = query({
  args: {},
  returns: v.object({ ok: v.boolean(), service: v.string() }),
  handler: async () => {
    return { ok: true, service: SERVICE_NAME };
  },
});
