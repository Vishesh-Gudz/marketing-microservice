import { formatChange, getDisplayLocale } from "./format";
import type { DeltaReason, MoneyDelta, NumberDelta } from "./types";
import { formatNumber, moneyView, VALUES, type ValueKey } from "./values";

/**
 * Comparison display (D9). Values come from the API; the dashboard only picks
 * a direction, a tone and texts. `percent` is a relative change (fraction);
 * `absolute` is the difference in the metric's own unit.
 */

export type DeltaTone = "positive" | "negative" | "neutral";
export type DeltaDirection = "up" | "down" | "flat";

/** Metrics where a decrease is an improvement. */
const LOWER_IS_BETTER: ReadonlySet<string> = new Set([
  "cpc",
  "cpm",
  "costPerConversion",
  "costPerAction",
]);
/** Metrics where more is neither good nor bad on its own. */
const NEUTRAL: ReadonlySet<string> = new Set(["spend"]);

export function deltaDirection(percent: number): DeltaDirection {
  if (percent > 0) return "up";
  if (percent < 0) return "down";
  return "flat";
}

export function deltaTone(metric: string, percent: number): DeltaTone {
  const direction = deltaDirection(percent);
  if (direction === "flat" || NEUTRAL.has(metric)) return "neutral";
  const improved = LOWER_IS_BETTER.has(metric) ? direction === "down" : direction === "up";
  return improved ? "positive" : "negative";
}

export const DELTA_REASON_TEXT: Record<DeltaReason, string> = {
  previous_zero: "New (no previous value)",
  previous_unavailable: "No comparison data",
  mixed_currency: "Currencies differ",
};

/** The absolute change with an explicit sign, in the metric's unit (display only). */
export function formatAbsoluteChange(
  metric: string,
  absolute: NumberDelta["absolute"] | MoneyDelta["absolute"],
  locale: string | undefined = getDisplayLocale(),
): string | undefined {
  if (absolute === undefined || !(metric in VALUES)) return undefined;
  const kind = VALUES[metric as ValueKey].kind;
  if (typeof absolute === "number") {
    const sign = absolute > 0 ? "+" : "";
    if (kind === "percent") {
      // A change of a ratio is shown in percentage points.
      const points = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(absolute * 100);
      return `${sign}${points} pp`;
    }
    return `${sign}${formatNumber(absolute, kind, locale)}`;
  }
  const money = moneyView(absolute, locale);
  if (money === undefined || money.detail) return undefined;
  return money.text.startsWith("-") ? money.text : `+${money.text}`;
}

export type DeltaView =
  | {
      kind: "change";
      text: string;
      /** Absolute change, when the API provides one in a single unit/currency. */
      absoluteText?: string;
      direction: DeltaDirection;
      tone: DeltaTone;
      /** Current or previous value is based on partial data. */
      partial: boolean;
    }
  | { kind: "reason"; text: string; partial: boolean }
  | { kind: "none" };

/**
 * An omitted delta (the current value is unavailable) renders nothing; a delta
 * without a percent renders its reason.
 */
export function deltaView(
  metric: string,
  delta: NumberDelta | MoneyDelta | undefined,
  locale: string | undefined = getDisplayLocale(),
): DeltaView {
  if (delta === undefined) return { kind: "none" };
  const partial = delta.partial === true;
  if (delta.percent !== undefined) {
    const absoluteText = formatAbsoluteChange(metric, delta.absolute, locale);
    return {
      kind: "change",
      text: formatChange(delta.percent, locale),
      ...(absoluteText ? { absoluteText } : {}),
      direction: deltaDirection(delta.percent),
      tone: deltaTone(metric, delta.percent),
      partial,
    };
  }
  if (delta.reason !== undefined) {
    return { kind: "reason", text: DELTA_REASON_TEXT[delta.reason], partial };
  }
  return { kind: "none" };
}
