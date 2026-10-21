// Sanitized, read-only views of v1 API results for the Google Ads tester (T2: terminal
// reports). Only DTO fields are printed; no ids beyond customer / connection ids, no tokens.

import { formatCustomerId } from "./select.mjs";

/** Exact decimal string of int64 micros ("1234567" → "1.234567"); no floating point. */
export function microsToDecimal(micros) {
  const text = String(micros);
  if (!/^-?\d+$/.test(text)) return "?";
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function money(amounts) {
  if (!amounts) return "—";
  const native = amounts.native ?? [];
  if (native.length === 0) return "—";
  return native.map((a) => `${microsToDecimal(a.micros)} ${a.currency}`).join(" + ");
}

function num(value) {
  return value === undefined || value === null ? "—" : String(value);
}

export function connectionLines(connections) {
  if (connections.length === 0) return ["No connections."];
  return connections.map((c) =>
    [
      `connection ${c.id}`,
      `provider=${c.provider}`,
      `status=${c.status}`,
      `missingScopes=${c.missingScopes.length ? c.missingScopes.join(",") : "none"}`,
      c.expiresSoon ? "expiresSoon" : undefined,
      c.lastError ? `lastError=${c.lastError.kind}: ${c.lastError.message}` : undefined,
    ]
      .filter(Boolean)
      .join(" | "),
  );
}

export function accountSyncLines(accounts) {
  const linked = accounts.filter((a) => a.linked);
  if (linked.length === 0) return ["No linked ad accounts."];
  return linked.map((a) => {
    const s = a.sync;
    const sync = s
      ? [
          `sync=${s.syncState}`,
          s.lastRunStatus ? `lastRun=${s.lastRunStatus}` : "lastRun=none",
          `lastSuccess=${s.lastSuccessAt ?? "never"}`,
          `coverage=${s.coveredFrom && s.coveredThrough ? `${s.coveredFrom}..${s.coveredThrough}` : "none"}`,
          `failures=${s.consecutiveFailures}`,
          s.nextRunAt ? `nextRun=${s.nextRunAt}` : undefined,
          s.lastError
            ? `lastError=${s.lastError.kind}${s.lastError.reason ? ` (${s.lastError.reason})` : ""}: ${s.lastError.message}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" | ")
      : "sync=not planned yet";
    return `${a.platform} ${formatCustomerId(a.externalId)} "${a.name}" | ${sync}`;
  });
}

export function overviewLines(overview) {
  const m = overview.totals.metrics;
  const lines = [
    `range ${overview.range.from}..${overview.range.to} | accounts=${overview.accountCount} | dataState=${overview.totals.dataState}`,
    `spend=${money(m.spend)} | impressions=${num(m.impressions)} | clicks=${num(m.clicks)} | conversions=${num(m.conversions)} | allConversions=${num(m.allConversions)}`,
  ];
  for (const c of overview.coverage.accounts) {
    lines.push(
      `coverage account ${c.accountId}: ${c.coveredFrom ?? "?"}..${c.coveredThrough ?? "?"} | daysUncovered=${c.daysUncovered} | lastSynced=${c.lastSyncedAt ?? "never"}`,
    );
  }
  return lines;
}

export function campaignLines(page) {
  if (page.length === 0) return ["No campaigns with data in this range."];
  return page.map(
    (row) =>
      `campaign ${row.entity.externalId} "${row.entity.name}" | status=${row.entity.status} | dataState=${row.dataState} | spend=${money(row.metrics.spend)} | impressions=${num(row.metrics.impressions)} | clicks=${num(row.metrics.clicks)}`,
  );
}
