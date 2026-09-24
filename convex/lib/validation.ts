import { v, type Infer } from "convex/values";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = ["viewer", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const roleValidator = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"));

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** True when `role` is at least `minRole` in the viewer < editor < admin hierarchy. */
export function hasRole(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

// ---------------------------------------------------------------------------
// Identifiers and settings
// ---------------------------------------------------------------------------

const EXTERNAL_ORG_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidExternalOrgId(value: unknown): value is string {
  return typeof value === "string" && EXTERNAL_ORG_ID.test(value);
}

const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidAppSlug(value: string): boolean {
  return APP_SLUG.test(value);
}

export const DISPLAY_NAME_MAX = 120;

/** Trims and validates a display name; returns null when invalid. */
export function normalizeDisplayName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= DISPLAY_NAME_MAX ? trimmed : null;
}

let supportedCurrencies: ReadonlySet<string> | null | undefined;

function getSupportedCurrencies(): ReadonlySet<string> | null {
  if (supportedCurrencies === undefined) {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    supportedCurrencies = intl.supportedValuesOf
      ? new Set(intl.supportedValuesOf("currency"))
      : null;
  }
  return supportedCurrencies;
}

/** ISO 4217 alphabetic code, e.g. "USD". */
export function isValidCurrency(value: string): boolean {
  if (!/^[A-Z]{3}$/.test(value)) return false;
  const known = getSupportedCurrencies();
  return known === null || known.has(value);
}

/** IANA time zone name, e.g. "Europe/Berlin". */
export function isValidTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditScalarValidator = v.union(v.string(), v.number(), v.boolean(), v.null());

/** Small before/after summary. Never put secrets or tokens here. */
export const auditChangesValidator = v.record(
  v.string(),
  v.object({ from: auditScalarValidator, to: auditScalarValidator }),
);

export type AuditChanges = Infer<typeof auditChangesValidator>;
