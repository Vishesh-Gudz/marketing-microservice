import { vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { orgScopeFromOrganization } from "../../mapping/scope";
import { upsertLinkedSocialAccount } from "../../sync/upsert";
import type { Backend } from "../../test.helpers";
import { signBody } from "../../whatsapp/fakeWebhook.fixtures";
import { INSTAGRAM_MESSAGING_SCOPE } from "../../providers/instagram/config";
import { enableMessaging } from "./accounts";
import { INSTAGRAM_MESSAGING_ENV, INSTAGRAM_WEBHOOK_PATH } from "./config";

/**
 * Signed fake Instagram messaging deliveries (test harness; two dots in the file name: never
 * deployed). Payloads follow Meta's DOCUMENTED shape (Instagram webhooks examples, read
 * 2026-10-29); they are not recordings and not evidence of real Meta behavior. All ids and
 * secrets are fake.
 */

export const FAKE_IG_WEBHOOK_SECRET = "test-instagram-webhook-secret";
export const FAKE_IG_VERIFY_TOKEN = "test-instagram-verify-token";

/** Professional account ids: 17 digits, more than a JSON number holds exactly. */
export const IG_ACCOUNT = "17841400000000101";
export const IG_ACCOUNT_2 = "17841400000000202";
export const CUSTOMER_1 = "5550000000000001";
export const CUSTOMER_2 = "5550000000000002";

export function stubInstagramWebhookEnv(): void {
  vi.stubEnv(INSTAGRAM_MESSAGING_ENV.webhookAppSecret, FAKE_IG_WEBHOOK_SECRET);
  vi.stubEnv(INSTAGRAM_MESSAGING_ENV.webhookVerifyToken, FAKE_IG_VERIFY_TOKEN);
}

type Item = Record<string, unknown>;
type Parties = { customer?: string; account?: string; timestamp?: number };

function toAccount({ customer, account, timestamp }: Parties) {
  return {
    sender: { id: customer ?? CUSTOMER_1 },
    recipient: { id: account ?? IG_ACCOUNT },
    timestamp: timestamp ?? Date.now(),
  };
}

function fromAccount({ customer, account, timestamp }: Parties) {
  return {
    sender: { id: account ?? IG_ACCOUNT },
    recipient: { id: customer ?? CUSTOMER_1 },
    timestamp: timestamp ?? Date.now(),
  };
}

/** A customer's message; `message` adds to or overrides its fields. */
export function customerMessage(
  mid: string,
  options: Parties & { text?: string; message?: Item } = {},
): Item {
  return {
    ...toAccount(options),
    message: { mid, text: options.text ?? "hello", ...options.message },
  };
}

/** A message the business sent from Instagram itself, echoed to the app. */
export function echo(mid: string, options: Parties & { text?: string } = {}): Item {
  return {
    ...fromAccount(options),
    message: { mid, text: options.text ?? "hi there", is_echo: true },
  };
}

export function seen(mid: string, options: Parties = {}): Item {
  return { ...toAccount(options), read: { mid } };
}

export function edited(mid: string, text: string, numEdit: number, options: Parties = {}): Item {
  return { ...toAccount(options), message_edit: { mid, text, num_edit: numEdit } };
}

export function deleted(mid: string, options: Parties = {}): Item {
  return { ...toAccount(options), message: { mid, is_deleted: true } };
}

export function entry(items: Item[], account = IG_ACCOUNT): Item {
  return { id: account, time: Date.now(), messaging: items };
}

export function delivery(...entries: Item[]): Item {
  return { object: "instagram", entry: entries };
}

type FetchBackend = { fetch: (path: string, init?: RequestInit) => Promise<Response> };

/** POSTs a delivery signed over its exact serialized bytes (or with an explicit header). */
export async function postDelivery(
  t: FetchBackend,
  payload: unknown,
  options: { secret?: string; signature?: string | null; rawBody?: string } = {},
): Promise<Response> {
  const body = options.rawBody ?? JSON.stringify(payload);
  const signature =
    options.signature === undefined
      ? await signBody(body, options.secret ?? FAKE_IG_WEBHOOK_SECRET)
      : options.signature;
  return await t.fetch(INSTAGRAM_WEBHOOK_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== null ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
}

/**
 * An Instagram account linked through its own connection, as connect + link leave it (the
 * account row through the canonical write path, convex/sync/upsert.ts).
 */
export async function seedLinked(
  t: Backend,
  orgId: Id<"organizations">,
  options: { igAccountId?: string } = {},
) {
  const igAccountId = options.igAccountId ?? IG_ACCOUNT;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("connections", {
      orgId,
      provider: "instagram",
      externalUserId: igAccountId,
      status: "active",
      grantedScopes: ["instagram_business_basic", INSTAGRAM_MESSAGING_SCOPE],
      credentialVersion: 1,
      connectedBySubject: "user_admin",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const { socialAccountId } = await upsertLinkedSocialAccount(
      ctx.db,
      orgScopeFromOrganization((await ctx.db.get(orgId))!),
      { platform: "instagram", externalId: igAccountId, username: "shop", accountType: "business" },
      connectionId,
      now,
    );
    return { connectionId, socialAccountId };
  });
}

/** A linked account with messaging turned on for the org (the hold starts now). */
export async function seedHolder(
  t: Backend,
  org: { orgId: Id<"organizations">; issuer: string },
  options: { igAccountId?: string } = {},
) {
  const linked = await seedLinked(t, org.orgId, options);
  const enabled = await t.run((ctx) =>
    enableMessaging(
      ctx.db,
      { orgId: org.orgId, issuer: org.issuer, subject: "user_admin" },
      linked.socialAccountId,
    ),
  );
  if (!enabled.ok) throw new Error(`enable failed: ${enabled.reason}`);
  return { ...linked, accountId: enabled.accountId };
}
