import type { Doc, Id } from "../_generated/dataModel";
import type { SyncOperation } from "./plan";

/**
 * Phase 10 sync subject: what one syncAccounts / syncRuns / syncTasks row is about.
 * EXACTLY ONE of adAccountId / socialAccountId is set on every row (I-D5). Ad accounts and
 * social accounts are never confused: every engine path resolves the subject through
 * `subjectOf`, which fails closed on rows naming neither or both.
 */
export type SyncSubject =
  | { kind: "ad"; adAccountId: Id<"adAccounts"> }
  | { kind: "social"; socialAccountId: Id<"socialAccounts"> };

export type SubjectKind = SyncSubject["kind"];

type SubjectRow = {
  adAccountId?: Id<"adAccounts">;
  socialAccountId?: Id<"socialAccounts">;
};

export class SyncSubjectInvariantError extends Error {
  constructor() {
    super("Sync row must name exactly one subject");
    this.name = "SyncSubjectInvariantError";
  }
}

export function subjectOf(row: SubjectRow): SyncSubject {
  const { adAccountId, socialAccountId } = row;
  if (adAccountId !== undefined && socialAccountId === undefined) {
    return { kind: "ad", adAccountId };
  }
  if (socialAccountId !== undefined && adAccountId === undefined) {
    return { kind: "social", socialAccountId };
  }
  // Neither or both: never a valid sync row.
  throw new SyncSubjectInvariantError();
}

/** The subject's id field for inserts (exactly one key). */
export function subjectFields(
  subject: SyncSubject,
): { adAccountId: Id<"adAccounts"> } | { socialAccountId: Id<"socialAccounts"> } {
  return subject.kind === "ad"
    ? { adAccountId: subject.adAccountId }
    : { socialAccountId: subject.socialAccountId };
}

export function subjectId(subject: SyncSubject): Id<"adAccounts"> | Id<"socialAccounts"> {
  return subject.kind === "ad" ? subject.adAccountId : subject.socialAccountId;
}

export function sameSubject(a: SyncSubject, b: SyncSubject): boolean {
  return a.kind === b.kind && subjectId(a) === subjectId(b);
}

/** Audit target type of a subject. */
export function subjectTargetType(subject: SyncSubject): "adAccount" | "socialAccount" {
  return subject.kind === "ad" ? "adAccount" : "socialAccount";
}

/** A subject row together with its stored account document. */
export type SubjectAccount =
  { kind: "ad"; account: Doc<"adAccounts"> } | { kind: "social"; account: Doc<"socialAccounts"> };

export function subjectOfAccount(subject: SubjectAccount): SyncSubject {
  return subject.kind === "ad"
    ? { kind: "ad", adAccountId: subject.account._id }
    : { kind: "social", socialAccountId: subject.account._id };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const SOCIAL_SYNC_OPERATIONS = [
  "getSocialAccount",
  "listSocialPosts",
  "fetchPostMetrics",
  "fetchAccountMetrics",
] as const;
export type SocialSyncOperation = (typeof SOCIAL_SYNC_OPERATIONS)[number];

export type AnySyncOperation = Doc<"syncTasks">["operation"];

export function isSocialOperation(operation: AnySyncOperation): operation is SocialSyncOperation {
  return (SOCIAL_SYNC_OPERATIONS as readonly string[]).includes(operation);
}

/** Ad operations are exactly the Phase 5 SyncOperation set (convex/sync/plan.ts). */
export function isAdOperation(operation: AnySyncOperation): operation is SyncOperation {
  return !isSocialOperation(operation);
}

/** The mandatory first task of every run (verifies access; fatal when it fails). */
export function isPreflightOperation(operation: AnySyncOperation): boolean {
  return operation === "getAccount" || operation === "getSocialAccount";
}

/** Operations valid for a subject kind (an ad task never runs a social operation, and vice versa). */
export function operationMatchesSubject(kind: SubjectKind, operation: AnySyncOperation): boolean {
  return kind === "social" ? isSocialOperation(operation) : isAdOperation(operation);
}
