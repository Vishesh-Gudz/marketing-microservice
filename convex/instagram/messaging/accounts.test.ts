import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { AUDIT_ACTIONS } from "../../lib/audit";
import { ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../../test.helpers";
import { INSTAGRAM_MESSAGING_SCOPE } from "../../providers/instagram/config";
import { disableMessaging, enableMessaging } from "./accounts";

// ADR 0017 (IM1): turning Instagram direct messages on and off, one org at a time per Instagram
// account. In-process only (convex-test); nothing here calls Meta.

const IG_ACCOUNT = "17841400000000101";
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
  INSTAGRAM_MESSAGING_SCOPE,
];

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "77");
  return {
    t,
    actorA: { orgId: orgA, issuer: ISSUER_ERP, subject: "user_admin_a" },
    actorB: { orgId: orgB, issuer: ISSUER_CRM, subject: "user_admin_b" },
  };
}

/** The Instagram account linked through its own connection, as connect + link leave it. */
async function seedLinked(
  t: Backend,
  orgId: Id<"organizations">,
  connection: { grantedScopes?: string[]; status?: "active" | "needs_reauth" } = {},
  linked = true,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("connections", {
      orgId,
      provider: "instagram",
      externalUserId: IG_ACCOUNT,
      status: connection.status ?? "active",
      grantedScopes: connection.grantedScopes ?? SCOPES,
      credentialVersion: 1,
      connectedBySubject: "user_admin",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("socialAccounts", {
      orgId,
      platform: "instagram",
      externalId: IG_ACCOUNT,
      name: "Shop",
      accountType: "business",
      status: "active",
      ...(linked ? { connectionId, linkedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function auditActions(t: Backend, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect())
      .filter((entry) => entry.orgId === orgId && entry.action.startsWith("instagram."))
      .map((entry) => entry.action),
  );
}

describe("enableMessaging", () => {
  it("turns messaging on once, as a hold starting now, with an audit entry", async () => {
    const { t, actorA } = await setup();
    const socialAccountId = await seedLinked(t, actorA.orgId);

    const first = await t.run((ctx) => enableMessaging(ctx.db, actorA, socialAccountId));
    if (!first.ok) throw new Error("expected enable");
    expect(first.changed).toBe(true);
    const again = await t.run((ctx) => enableMessaging(ctx.db, actorA, socialAccountId));
    expect(again).toEqual({ ok: true, accountId: first.accountId, changed: false });

    const account = (await t.run((ctx) => ctx.db.get(first.accountId)))!;
    expect(account).toMatchObject({
      orgId: actorA.orgId,
      socialAccountId,
      igAccountId: IG_ACCOUNT,
      status: "active",
      enabledBySubject: "user_admin_a",
    });
    expect(account.activatedAt).toBe(account.createdAt);
    expect(await auditActions(t, actorA.orgId)).toEqual([AUDIT_ACTIONS.instagramMessagingEnabled]);
  });

  it.each([
    ["another org's account", "not_found"],
    ["an account not linked to a connection", "not_linked"],
    ["a connection that needs reauthorization", "connection_inactive"],
    ["a connection without the messaging permission", "scope_missing"],
  ] as const)("refuses %s", async (_case, reason) => {
    const { t, actorA, actorB } = await setup();
    const socialAccountId =
      reason === "not_found"
        ? await seedLinked(t, actorB.orgId)
        : reason === "not_linked"
          ? await seedLinked(t, actorA.orgId, {}, false)
          : reason === "connection_inactive"
            ? await seedLinked(t, actorA.orgId, { status: "needs_reauth" })
            : await seedLinked(t, actorA.orgId, { grantedScopes: SCOPES.slice(0, 2) });

    expect(await t.run((ctx) => enableMessaging(ctx.db, actorA, socialAccountId))).toEqual({
      ok: false,
      reason,
    });
    expect(await t.run((ctx) => ctx.db.query("instagramMessagingAccounts").collect())).toEqual([]);
  });

  it("lets one org at a time hold an account that both orgs keep linked for analytics", async () => {
    const { t, actorA, actorB } = await setup();
    const linkedA = await seedLinked(t, actorA.orgId);
    const linkedB = await seedLinked(t, actorB.orgId);

    const heldByA = await t.run((ctx) => enableMessaging(ctx.db, actorA, linkedA));
    if (!heldByA.ok) throw new Error("expected org A to enable");
    expect(await t.run((ctx) => enableMessaging(ctx.db, actorB, linkedB))).toEqual({
      ok: false,
      reason: "in_use",
    });

    // Waiting for action still holds the account.
    await t.run((ctx) => ctx.db.patch(heldByA.accountId, { status: "action_required" }));
    expect(await t.run((ctx) => enableMessaging(ctx.db, actorB, linkedB))).toEqual({
      ok: false,
      reason: "in_use",
    });

    // Turned off, it is free for the other org; then the first org is refused.
    await t.run((ctx) => disableMessaging(ctx.db, actorA, heldByA.accountId, "turned_off"));
    expect(await t.run((ctx) => enableMessaging(ctx.db, actorB, linkedB))).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await t.run((ctx) => enableMessaging(ctx.db, actorA, linkedA))).toEqual({
      ok: false,
      reason: "in_use",
    });

    const linked = await t.run((ctx) => ctx.db.query("socialAccounts").collect());
    expect(linked.map((row) => row.connectionId !== undefined)).toEqual([true, true]);
  });

  it("re-enables a turned-off account as a new hold, without its earlier setup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const { t, actorA } = await setup();
    const socialAccountId = await seedLinked(t, actorA.orgId);
    const enabled = await t.run((ctx) => enableMessaging(ctx.db, actorA, socialAccountId));
    if (!enabled.ok) throw new Error("expected enable");
    await t.run(async (ctx) => {
      await ctx.db.patch(enabled.accountId, {
        subscribedAt: t0,
        subscribedFields: ["messages"],
        setupError: { step: "subscribe", reason: "meta_100", at: t0 },
      });
      await disableMessaging(ctx.db, actorA, enabled.accountId, "turned_off");
    });

    vi.setSystemTime(t0 + 60_000);
    const again = await t.run((ctx) => enableMessaging(ctx.db, actorA, socialAccountId));
    expect(again).toEqual({ ok: true, accountId: enabled.accountId, changed: true });

    const account = await t.run((ctx) => ctx.db.get(enabled.accountId));
    expect(account).toMatchObject({ status: "active", activatedAt: t0 + 60_000 });
    expect(account?.subscribedAt).toBeUndefined();
    expect(account?.subscribedFields).toBeUndefined();
    expect(account?.setupError).toBeUndefined();
    expect(account?.disabledAt).toBeUndefined();
    expect(await auditActions(t, actorA.orgId)).toEqual([
      AUDIT_ACTIONS.instagramMessagingEnabled,
      AUDIT_ACTIONS.instagramMessagingDisabled,
      AUDIT_ACTIONS.instagramMessagingEnabled,
    ]);
  });
});

describe("disableMessaging", () => {
  it("turns messaging off for its own org only, once", async () => {
    const { t, actorA, actorB } = await setup();
    const socialAccountId = await seedLinked(t, actorA.orgId);
    const enabled = await t.run((ctx) => enableMessaging(ctx.db, actorA, socialAccountId));
    if (!enabled.ok) throw new Error("expected enable");

    expect(
      await t.run((ctx) => disableMessaging(ctx.db, actorB, enabled.accountId, "turned_off")),
    ).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(enabled.accountId))).toMatchObject({ status: "active" });

    expect(
      await t.run((ctx) => disableMessaging(ctx.db, actorA, enabled.accountId, "turned_off")),
    ).toBe(true);
    expect(
      await t.run((ctx) => disableMessaging(ctx.db, actorA, enabled.accountId, "turned_off")),
    ).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(enabled.accountId))).toMatchObject({
      status: "disabled",
      disabledBySubject: "user_admin_a",
    });
    expect(await auditActions(t, actorB.orgId)).toEqual([]);
    expect(await auditActions(t, actorA.orgId)).toEqual([
      AUDIT_ACTIONS.instagramMessagingEnabled,
      AUDIT_ACTIONS.instagramMessagingDisabled,
    ]);
  });
});
