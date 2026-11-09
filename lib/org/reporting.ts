import { isMarketingError } from "@/convex/lib/errors";
import type { Notice } from "@/lib/connections/types";

// The organization's reporting settings (C1): the currency totals are shown in and the time
// zone that sets "today", the date presets and the times shown in the inbox. The server checks
// every value again (`v1/orgs:updateSettings`: ISO 4217 codes, IANA zones, admins only).

/** Offered first: India, then the currencies ad accounts most often use. */
export const COMMON_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD"] as const;

export type Option = { value: string; label: string };

function supported(kind: "currency" | "timeZone"): string[] {
  try {
    return Intl.supportedValuesOf(kind);
  } catch {
    return [];
  }
}

/** "INR · Indian Rupee", or the bare code when the browser has no name for it. */
export function currencyLabel(code: string, locale?: string): string {
  try {
    const name = new Intl.DisplayNames(locale === undefined ? undefined : [locale], {
      type: "currency",
    }).of(code);
    return name !== undefined && name !== code ? `${code} · ${name}` : code;
  } catch {
    return code;
  }
}

/**
 * The currency choices in two groups: the common ones, then every other ISO 4217 code the
 * browser knows (A to Z). The current value is always offered, even if the browser lacks it.
 */
export function currencyGroups(
  current: string,
  locale?: string,
): { label: string; options: Option[] }[] {
  const common = new Set<string>(COMMON_CURRENCIES);
  const others = new Set(supported("currency").filter((code) => !common.has(code)));
  if (!common.has(current)) others.add(current);
  return [
    {
      label: "Common",
      options: COMMON_CURRENCIES.map((code) => ({
        value: code,
        label: currencyLabel(code, locale),
      })),
    },
    {
      label: "All currencies",
      options: [...others]
        .sort()
        .map((code) => ({ value: code, label: currencyLabel(code, locale) })),
    },
  ];
}

/** "GMT+5:30" for a zone at `at` (daylight saving changes it), or "" when unknown. */
export function zoneOffset(zone: string, at: number, locale?: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale ?? "en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

function zoneOption(zone: string, at: number, locale?: string): Option {
  const offset = zoneOffset(zone, at, locale);
  return { value: zone, label: offset ? `${zone} · ${offset}` : zone };
}

/**
 * The time zone choices: the browser's own zone and India's first (when they differ from each
 * other), then every IANA zone the browser knows plus UTC (A to Z). The current value is always
 * offered.
 */
export function timeZoneGroups(
  current: string,
  browserZone: string | undefined,
  at: number,
  locale?: string,
): { label: string; options: Option[] }[] {
  const suggested = [...new Set([browserZone, "Asia/Kolkata"].filter((z) => z !== undefined))];
  const all = new Set([...supported("timeZone"), "UTC", current]);
  for (const zone of suggested) all.delete(zone);
  return [
    { label: "Suggested", options: suggested.map((zone) => zoneOption(zone, at, locale)) },
    {
      label: "All time zones",
      options: [...all].sort().map((zone) => zoneOption(zone, at, locale)),
    },
  ];
}

/** The browser's time zone, or undefined (old browsers, tests). */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one currency every linked ad account reports in, or undefined (no accounts, or several
 * currencies). Manager accounts hold no spend and are ignored.
 */
export function soleAccountCurrency(
  accounts: readonly { currency: string; linked: boolean; isManager?: boolean }[] | undefined,
): string | undefined {
  if (accounts === undefined) return undefined;
  const currencies = new Set(
    accounts.filter((a) => a.linked && !a.isManager).map((a) => a.currency),
  );
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

/** A refused save, in fixed words (never the raw error). */
export function settingsErrorNotice(error: unknown): Notice {
  const code = isMarketingError(error) ? error.data.code : undefined;
  switch (code) {
    case "INVALID_ARGUMENT":
      return {
        tone: "error",
        title: "Setting not valid",
        message: "Choose a currency and a time zone from the lists, then save again.",
      };
    case "FORBIDDEN":
      return {
        tone: "error",
        title: "Only admins can change these",
        message: "Ask an admin of this organization to change the reporting settings.",
      };
    default:
      return {
        tone: "error",
        title: "Not saved",
        message: "The reporting settings could not be saved. Try again.",
      };
  }
}
