import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { apiError } from "../lib/errors";
import { isValidReturnUrlEntry } from "../connections/returnUrls";
import { isValidAppSlug, normalizeDisplayName } from "../lib/validation";

// INTERNAL ONLY. Operator tooling, invoked with `npx convex run` or from the
// Convex dashboard. Never exposed to clients.
//
// Registering an app here does not make its tokens verifiable: the issuer must
// also be present in the AUTH_ISSUERS env var (auth.config.ts). Both are required.

const appStatus = v.union(v.literal("active"), v.literal("disabled"));

/** Idempotent: registers the issuer, or updates slug/name if already registered. */
export const register = internalMutation({
  args: { issuer: v.string(), slug: v.string(), name: v.string() },
  returns: v.id("integrationApps"),
  handler: async (ctx, args) => {
    const issuer = args.issuer.trim();
    if (!issuer) throw apiError("INVALID_ARGUMENT", "issuer is required.");
    if (!isValidAppSlug(args.slug)) {
      throw apiError("INVALID_ARGUMENT", "slug must match ^[a-z0-9][a-z0-9-]{0,39}$.");
    }
    const name = normalizeDisplayName(args.name);
    if (name === null) throw apiError("INVALID_ARGUMENT", "name must be 1-120 characters.");

    const bySlug = await ctx.db
      .query("integrationApps")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (bySlug !== null && bySlug.issuer !== issuer) {
      throw apiError("CONFLICT", `slug "${args.slug}" is already used by another issuer.`);
    }

    const existing = await ctx.db
      .query("integrationApps")
      .withIndex("by_issuer", (q) => q.eq("issuer", issuer))
      .unique();
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { slug: args.slug, name, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("integrationApps", {
      issuer,
      slug: args.slug,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Kill switch: disabled apps are rejected on every call, without a redeploy. */
export const setStatus = internalMutation({
  args: { issuer: v.string(), status: appStatus },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("integrationApps")
      .withIndex("by_issuer", (q) => q.eq("issuer", args.issuer))
      .unique();
    if (app === null) throw apiError("NOT_FOUND", "No integration app for this issuer.");
    await ctx.db.patch(app._id, { status: args.status, updatedAt: Date.now() });
    return null;
  },
});

/** OAuth return-URL allowlist for an app (exact origin + path prefix). Replaces the list. */
export const setAllowedReturnUrls = internalMutation({
  args: { issuer: v.string(), urls: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("integrationApps")
      .withIndex("by_issuer", (q) => q.eq("issuer", args.issuer))
      .unique();
    if (app === null) throw apiError("NOT_FOUND", "No integration app for this issuer.");
    const invalid = args.urls.filter((url) => !isValidReturnUrlEntry(url));
    if (invalid.length > 0) {
      throw apiError(
        "INVALID_ARGUMENT",
        "Return URLs must be https (or http on localhost) without query or fragment.",
      );
    }
    await ctx.db.patch(app._id, {
      allowedReturnUrls: [...new Set(args.urls)],
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const list = internalQuery({
  args: {},
  returns: v.array(
    v.object({ issuer: v.string(), slug: v.string(), name: v.string(), status: appStatus }),
  ),
  handler: async (ctx) => {
    const apps = await ctx.db.query("integrationApps").collect();
    return apps.map(({ issuer, slug, name, status }) => ({ issuer, slug, name, status }));
  },
});
