import { validate } from "convex-helpers/validators";
import { v, type Infer, type Validator } from "convex/values";
import type { SocialAccountType } from "../../domain/types";
import type { ProviderOperation } from "../types";
import { instagramError } from "./errors";

/**
 * Raw Instagram response validators (Phase 10; Convex `v` + convex-helpers `validate`, as
 * for Meta and Google). Unknown fields are allowed (Meta adds fields over time); missing or
 * mistyped required fields are a non-retryable "data" error with a generic message. Raw
 * shapes never leave the Instagram provider: callers get our own types.
 */

/** [doc] Instagram returns ids as strings; tolerate JSON numbers too. */
const id = v.union(v.string(), v.number());

/** One entry of the code-exchange response (documented as `{ data: [entry] }`). */
export const rawShortLivedToken = v.object({
  access_token: v.string(),
  user_id: id,
  /** [doc] Comma-separated granted scopes; tolerate an array. */
  permissions: v.optional(v.union(v.string(), v.array(v.string()))),
});
export type RawShortLivedToken = Infer<typeof rawShortLivedToken>;

export const rawShortLivedEnvelope = v.object({ data: v.array(v.any()) });

/** [doc] Long-lived exchange and refresh responses. */
export const rawLongLivedToken = v.object({
  access_token: v.string(),
  token_type: v.optional(v.string()),
  expires_in: v.optional(v.number()),
});
export type RawLongLivedToken = Infer<typeof rawLongLivedToken>;

/** [doc] `/me?fields=user_id,username,account_type` (Instagram Login). */
export const rawIdentity = v.object({
  user_id: id,
  username: v.optional(v.string()),
  account_type: v.optional(v.string()),
  id: v.optional(id),
});
export type RawIdentity = Infer<typeof rawIdentity>;

export function parseRaw<T extends Validator<unknown, "required", string>>(
  validator: T,
  value: unknown,
  operation: ProviderOperation,
  what: string,
  stage?: string,
): Infer<T> {
  if (!validate(validator, value, { allowUnknownFields: true })) {
    throw instagramError(
      "data",
      operation,
      stage ? `${stage}:schema` : "schema",
      `Unexpected Instagram ${what} payload`,
    );
  }
  return value as Infer<T>;
}

/** Ids as canonical decimal strings (numbers must be safe integers). */
export function canonicalId(value: string | number): string | undefined {
  const text = typeof value === "number" ? (Number.isSafeInteger(value) ? `${value}` : "") : value;
  return /^\d{1,32}$/.test(text) ? text : undefined;
}

/**
 * I-D16 [doc] Instagram professional account types: Business -> business,
 * Media_Creator -> creator. ANY other value (including absent) fails closed: the canonical
 * enum has no "unknown" and personal accounts cannot use the Instagram API.
 */
export function mapAccountType(raw: string | undefined): SocialAccountType | undefined {
  switch (raw) {
    case "Business":
      return "business";
    case "Media_Creator":
      return "creator";
    default:
      return undefined;
  }
}

/** Granted scopes from `permissions` (comma string or array); unknown shapes grant nothing. */
export function parsePermissions(raw: RawShortLivedToken["permissions"]): string[] {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : raw.split(",");
  return [
    ...new Set(list.map((scope) => scope.trim()).filter((scope) => /^[a-z_]{1,64}$/.test(scope))),
  ];
}
