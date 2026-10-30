import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "../../lib/audit";
import { INSTAGRAM_MESSAGING_SCOPE } from "../../providers/instagram/config";
import { RETENTION_GRACE_MS } from "./config";
import type { MessagingAccountStatus } from "./validators";

/**
 * Instagram messaging accounts (ADR 0017): the state of direct messages for one org's linked
 * Instagram account. Database only: nothing here calls Meta (subscription.ts does). Callers pass
 * the org and actor from a verified JWT, or a system actor.
 *
 * - One org at a time per Instagram account: an account `active` or `action_required` in
 *   another org refuses the enable. The check reads the approved global index
 *   `by_ig_account_status` and runs in the same transaction as the write, so two orgs can never
 *   both hold it. Linking the account for analytics in several orgs is not affected.
 * - Messaging uses the account's own Instagram connection: active, for the same Instagram
 *   account, and granted `instagram_business_manage_messages` [doc].
 * - Every enable, and every re-enable after a turn-off, starts a new hold at `activatedAt`:
 *   webhook events from before it are dropped (ingest.ts), so late retries meant for an earlier
 *   holder never reach this org.
 * - Transitions (`TRANSITIONS`, enforced by every writer here):
 *     (none) / disabled -> active             enableMessaging only (all checks above)
 *     active -> action_required               the webhook subscription failed
 *     action_required -> active               the subscription succeeded (retry)
 *     active / action_required -> disabled    turned off, disconnected, unlinked, the
 *                                             permission removed, or a data-deletion request
 * - Stopping starts the D14 grace period (`purgeAfter`, purge.ts). A re-enable within it keeps
 *   the org's history; once it has ended (the purge due or running) a re-enable is refused
 *   until the purge is done.
 */

/** Statuses that hold an Instagram account for their org. */
const HOLDING_STATUSES: readonly MessagingAccountStatus[] = ["active", "action_required"];

/** The only status changes allowed. */
const TRANSITIONS: Readonly<Record<MessagingAccountStatus, readonly MessagingAccountStatus[]>> = {
  active: ["action_required", "disabled"],
  action_required: ["active", "disabled"],
  disabled: ["active"],
};

function assertTransition(from: MessagingAccountStatus, to: MessagingAccountStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid Instagram messaging transition: ${from} -> ${to}`);
  }
}

type Actor = { orgId: Id<"organizations">; issuer: string; subject: string };

export type EnableRefusal =
  /** Not an Instagram account of this org. */
  | "not_found"
  /** Not linked to an Instagram connection of this org for the same account. */
  | "not_linked"
  | "connection_inactive"
  | "scope_missing"
  /** Another org holds the account. Which one is never revealed. */
  | "in_use"
  /**
   * The grace period of an earlier turn-off has ended: its stored history is due for deletion
   * or being deleted; try again once the purge is done.
   */
  | "purge_in_progress";

/** Why messaging stopped (audited). */
export type StopReason =
  | "turned_off"
  | "disconnected"
  | "unlinked"
  | "permission_removed"
  | "deauthorized"
  | "data_deletion_request";

/** Rows holding this Instagram account, through the approved global index (at most 2 each). */
async function holdersOf(
  db: DatabaseReader,
  igAccountId: string,
): Promise<Doc<"instagramMessagingAccounts">[]> {
  const rows: Doc<"instagramMessagingAccounts">[] = [];
  for (const status of HOLDING_STATUSES) {
    rows.push(
      ...(await db
        .query("instagramMessagingAccounts")
        .withIndex("by_ig_account_status", (q) =>
          q.eq("igAccountId", igAccountId).eq("status", status),
        )
        .take(2)),
    );
  }
  return rows;
}

/** Whether ANOTHER org holds this Instagram account. Rows are only compared. */
async function heldElsewhere(
  db: DatabaseReader,
  igAccountId: string,
  orgId: Id<"organizations">,
): Promise<boolean> {
  return (await holdersOf(db, igAccountId)).some((row) => row.orgId !== orgId);
}

/**
 * Webhook routing (ADR 0017): the ONE row holding this Instagram account (`active` or
 * `action_required`), or null when none does or the one-holder rule is broken (more than one).
 * The holder is re-verified before it is trusted: its Instagram account and connection belong
 * to its org and to this account, and the connection was not disconnected (`revoked`). A
 * connection that only needs reauthorization still receives its customers' messages.
 */
export async function messagingHolder(
  db: DatabaseReader,
  igAccountId: string,
): Promise<Doc<"instagramMessagingAccounts"> | null> {
  const rows = await holdersOf(db, igAccountId);
  if (rows.length !== 1) return null;
  const holder = rows[0]!;
  const social = await db.get(holder.socialAccountId);
  if (
    social === null ||
    social.orgId !== holder.orgId ||
    social.platform !== "instagram" ||
    social.externalId !== igAccountId ||
    social.connectionId !== holder.connectionId
  ) {
    return null;
  }
  const connection = await db.get(holder.connectionId);
  if (
    connection === null ||
    connection.orgId !== holder.orgId ||
    connection.provider !== "instagram" ||
    connection.externalUserId !== igAccountId ||
    connection.status === "revoked"
  ) {
    return null;
  }
  return holder;
}

/**
 * Turns messaging on for a linked Instagram account. Idempotent: an account already on (or
 * waiting for action) is returned unchanged. A turned-off one is re-enabled as a new hold: new
 * `activatedAt`, its earlier subscription and setup error cleared, and (within its grace
 * period) its purge called off with the history kept.
 */
/**
 * Whether this org may turn messaging on for the account now (every check of an enable, read
 * only), with the account's messaging row if it has one.
 */
export async function enableCheck(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  socialAccountId: Id<"socialAccounts">,
): Promise<
  | {
      ok: true;
      social: Doc<"socialAccounts">;
      connection: Doc<"connections">;
      existing: Doc<"instagramMessagingAccounts"> | null;
    }
  | { ok: false; reason: EnableRefusal; existing: Doc<"instagramMessagingAccounts"> | null }
> {
  const social = await db.get(socialAccountId);
  if (social === null || social.orgId !== orgId || social.platform !== "instagram") {
    return { ok: false, reason: "not_found", existing: null };
  }
  const existing = await db
    .query("instagramMessagingAccounts")
    .withIndex("by_org_social_account", (q) =>
      q.eq("orgId", orgId).eq("socialAccountId", social._id),
    )
    .unique();
  const refuse = (reason: EnableRefusal) => ({ ok: false as const, reason, existing });
  const connection = social.connectionId === undefined ? null : await db.get(social.connectionId);
  if (
    connection === null ||
    connection.orgId !== orgId ||
    connection.provider !== "instagram" ||
    connection.externalUserId !== social.externalId
  ) {
    return refuse("not_linked");
  }
  if (connection.status !== "active") return refuse("connection_inactive");
  if (!connection.grantedScopes.includes(INSTAGRAM_MESSAGING_SCOPE)) return refuse("scope_missing");
  if (await heldElsewhere(db, social.externalId, orgId)) return refuse("in_use");
  // D14: once the grace period has ended the history is deleted before messaging can be on
  // again, whether or not the hourly sweep has started the purge yet.
  if (
    existing?.status === "disabled" &&
    (existing.purgeStartedAt !== undefined ||
      (existing.purgeAfter !== undefined && existing.purgeAfter <= Date.now()))
  ) {
    return refuse("purge_in_progress");
  }
  return { ok: true, social, connection, existing };
}

export async function enableMessaging(
  db: DatabaseWriter,
  actor: Actor,
  socialAccountId: Id<"socialAccounts">,
): Promise<
  | { ok: true; accountId: Id<"instagramMessagingAccounts">; changed: boolean }
  | { ok: false; reason: EnableRefusal }
> {
  const check = await enableCheck(db, actor.orgId, socialAccountId);
  if (!check.ok) return { ok: false, reason: check.reason };
  const { social, connection, existing } = check;
  if (existing !== null && existing.status !== "disabled") {
    return { ok: true, accountId: existing._id, changed: false };
  }

  const now = Date.now();
  const hold = {
    connectionId: connection._id,
    status: "active" as const,
    enabledBySubject: actor.subject,
    activatedAt: now,
    updatedAt: now,
  };
  let accountId: Id<"instagramMessagingAccounts">;
  if (existing === null) {
    accountId = await db.insert("instagramMessagingAccounts", {
      orgId: actor.orgId,
      socialAccountId: social._id,
      igAccountId: social.externalId,
      ...hold,
      createdAt: now,
    });
  } else {
    assertTransition(existing.status, "active");
    accountId = existing._id;
    await db.patch(accountId, {
      ...hold,
      subscribedAt: undefined,
      subscribedFields: undefined,
      setupError: undefined,
      disabledAt: undefined,
      disabledBySubject: undefined,
      purgeAfter: undefined,
    });
  }
  await writeAudit(db, actor, {
    action: AUDIT_ACTIONS.instagramMessagingEnabled,
    targetType: "instagramMessagingAccount",
    targetId: accountId,
    changes: {
      status: { from: existing?.status ?? null, to: "active" },
      ...(existing?.purgeAfter !== undefined ? { historyKept: { from: null, to: true } } : {}),
    },
  });
  return { ok: true, accountId, changed: true };
}

/**
 * Turns messaging off: from now on the account's webhook events reach no org, any org may
 * enable it, and its grace period starts (a data-deletion request purges at once). Returns
 * false when nothing changed (not this org's account, or already off).
 */
export async function disableMessaging(
  db: DatabaseWriter,
  actor: Actor,
  accountId: Id<"instagramMessagingAccounts">,
  reason: StopReason,
): Promise<boolean> {
  const account = await db.get(accountId);
  if (account === null || account.orgId !== actor.orgId || account.status === "disabled") {
    return false;
  }
  assertTransition(account.status, "disabled");
  const now = Date.now();
  const purgeAfter = reason === "data_deletion_request" ? now : now + RETENTION_GRACE_MS;
  await db.patch(accountId, {
    status: "disabled",
    disabledAt: now,
    disabledBySubject: actor.subject,
    purgeAfter,
    updatedAt: now,
  });
  await writeAudit(db, actor, {
    action: AUDIT_ACTIONS.instagramMessagingDisabled,
    targetType: "instagramMessagingAccount",
    targetId: accountId,
    changes: {
      status: { from: account.status, to: "disabled" },
      reason: { from: null, to: reason },
      purgeAfter: { from: null, to: purgeAfter },
    },
  });
  return true;
}

/** Unlink (connections/socialAssets.ts): stops messaging for that account. */
export async function stopMessagingForSocialAccount(
  db: DatabaseWriter,
  actor: Actor,
  socialAccountId: Id<"socialAccounts">,
  reason: Extract<StopReason, "unlinked">,
): Promise<boolean> {
  const account = await db
    .query("instagramMessagingAccounts")
    .withIndex("by_org_social_account", (q) =>
      q.eq("orgId", actor.orgId).eq("socialAccountId", socialAccountId),
    )
    .unique();
  return account !== null && (await disableMessaging(db, actor, account._id, reason));
}

/**
 * Every messaging account of a connection stops: on disconnect (connections/socialAssets.ts),
 * on a reconnect whose grant lacks the permission, and when Meta reports that the user removed
 * the app (deauthorize callback, IM6). Returns how many stopped.
 */
export async function stopMessagingForConnection(
  db: DatabaseWriter,
  actor: Actor,
  connectionId: Id<"connections">,
  reason: Extract<StopReason, "disconnected" | "permission_removed" | "deauthorized">,
): Promise<number> {
  // One Instagram connection is one Instagram account: at most one row per org in practice.
  const accounts = await db
    .query("instagramMessagingAccounts")
    .withIndex("by_org_connection", (q) =>
      q.eq("orgId", actor.orgId).eq("connectionId", connectionId),
    )
    .take(50);
  let stopped = 0;
  for (const account of accounts) {
    if (await disableMessaging(db, actor, account._id, reason)) stopped++;
  }
  return stopped;
}

/**
 * A reconnect (connections/credentialStore.ts claimGrant) whose grant lacks the messaging
 * permission stops messaging on that connection: Meta no longer delivers its messages, so its
 * hold must not block other orgs.
 */
export async function stopMessagingWithoutPermission(
  db: DatabaseWriter,
  actor: Actor,
  connectionId: Id<"connections">,
  grantedScopes: readonly string[],
): Promise<number> {
  if (grantedScopes.includes(INSTAGRAM_MESSAGING_SCOPE)) return 0;
  return await stopMessagingForConnection(db, actor, connectionId, "permission_removed");
}

/** The webhook subscription succeeded: the account is (again) fully active. */
export async function recordSubscribed(
  db: DatabaseWriter,
  actor: Actor,
  accountId: Id<"instagramMessagingAccounts">,
  fields: readonly string[],
): Promise<boolean> {
  const account = await db.get(accountId);
  if (account === null || account.orgId !== actor.orgId || account.status === "disabled") {
    return false;
  }
  if (account.status !== "active") assertTransition(account.status, "active");
  const now = Date.now();
  await db.patch(accountId, {
    status: "active",
    subscribedAt: now,
    subscribedFields: [...fields],
    setupError: undefined,
    updatedAt: now,
  });
  await writeAudit(db, actor, {
    action: AUDIT_ACTIONS.instagramMessagingSetupCompleted,
    targetType: "instagramMessagingAccount",
    targetId: accountId,
    changes: { status: { from: account.status, to: "active" } },
  });
  return true;
}

/** The webhook subscription failed: the account waits for action (it still holds). */
export async function recordActionRequired(
  db: DatabaseWriter,
  actor: Actor,
  accountId: Id<"instagramMessagingAccounts">,
  reason: string,
): Promise<boolean> {
  const account = await db.get(accountId);
  if (account === null || account.orgId !== actor.orgId || account.status === "disabled") {
    return false;
  }
  if (account.status !== "action_required") assertTransition(account.status, "action_required");
  const now = Date.now();
  await db.patch(accountId, {
    status: "action_required",
    setupError: { step: "subscribe", reason, at: now },
    updatedAt: now,
  });
  await writeAudit(db, actor, {
    action: AUDIT_ACTIONS.instagramMessagingActionRequired,
    targetType: "instagramMessagingAccount",
    targetId: accountId,
    changes: {
      status: { from: account.status, to: "action_required" },
      reason: { from: null, to: reason },
    },
  });
  return true;
}
