import { describe, expect, it } from "vitest";
import {
  addToCarry,
  decodeCarry,
  encodeCarry,
  takeFromCarry,
  type Carry,
  type CarrySpec,
} from "./carry";
import { META_MAPPING } from "./mapping";

// Phase 8 R9: accumulation of records whose canonical key collects several raw rows
// ("other" placement) across the pages of a staged insights request.

const metricSpec = META_MAPPING.dailyMetrics!.carry;
const actionSpec = META_MAPPING.actionMetrics!.carry;

const derived = { platform: "meta", accountExternalId: "1001", level: "ad" };
const other = (fields: Record<string, unknown>) => ({
  ...derived,
  entityExternalId: "4004",
  date: "2026-03-02",
  placement: "other",
  currency: "USD",
  ...fields,
});

function merge(spec: CarrySpec, ...records: Record<string, unknown>[]) {
  const carry: Carry = new Map();
  for (const record of records) addToCarry(carry, record, spec);
  return takeFromCarry(carry, 100);
}

describe("addToCarry: missing vs zero is preserved exactly", () => {
  it("sums metrics every contribution reported; an explicit 0 stays 0", () => {
    const [row] = merge(
      metricSpec,
      other({ rawPlacement: "unknown", spendMicros: 370_000n, impressions: 41, clicks: 0 }),
      other({ rawPlacement: "oculus", spendMicros: 520_000n, impressions: 60, clicks: 0 }),
    );
    expect(row).toEqual(
      other({
        rawPlacement: "oculus,unknown",
        spendMicros: 890_000n,
        impressions: 101,
        clicks: 0,
      }),
    );
  });

  it("keeps a metric absent when no contribution reported it", () => {
    const [row] = merge(
      metricSpec,
      other({ rawPlacement: "a", impressions: 1 }),
      other({ rawPlacement: "b", impressions: 2 }),
    );
    expect(row).not.toHaveProperty("linkClicks");
    expect(row).not.toHaveProperty("spendMicros");
  });

  it("makes a metric absent (unknown) when only some contributions reported it", () => {
    for (const order of [
      [{ reactions: 1 }, {}],
      [{}, { reactions: 1 }],
      [{ reactions: 1 }, {}, { reactions: 2 }],
      [{ reactions: 0 }, {}],
    ]) {
      const [row] = merge(
        metricSpec,
        ...order.map((fields, i) => other({ rawPlacement: `p${i}`, impressions: 1, ...fields })),
      );
      expect(row, JSON.stringify(order)).not.toHaveProperty("reactions");
      expect(row!.impressions).toBe(order.length);
    }
  });

  it("action rows: counts sum; values sum only when every contribution has one", () => {
    const action = (fields: Record<string, unknown>) =>
      other({
        actionType: "purchase",
        rawActionType: "omni_purchase",
        attributionWindow: "7d_click",
        attributionBasis: "impression_or_click_date",
        isPrimary: true,
        ...fields,
      });
    expect(
      merge(
        actionSpec,
        action({ rawPlacement: "a", count: 2, valueMicros: 9_100_000n }),
        action({ rawPlacement: "b", count: 1, valueMicros: 4_550_000n }),
      )[0],
    ).toMatchObject({ count: 3, valueMicros: 13_650_000n });
    const partial = merge(
      actionSpec,
      action({ rawPlacement: "a", count: 2, valueMicros: 9_100_000n }),
      action({ rawPlacement: "b", count: 1 }),
    )[0]!;
    expect(partial.count).toBe(3);
    expect(partial).not.toHaveProperty("valueMicros");
    // Different windows or action types are different keys (never merged).
    expect(
      merge(
        actionSpec,
        action({ rawPlacement: "a", count: 1 }),
        action({ rawPlacement: "a", count: 1, attributionWindow: "1d_click" }),
      ),
    ).toHaveLength(2);
  });

  it("rejects inconsistent identity fields for one key", () => {
    const carry: Carry = new Map();
    addToCarry(carry, other({ rawPlacement: "a", impressions: 1 }), metricSpec);
    expect(() =>
      addToCarry(carry, other({ rawPlacement: "b", impressions: 1, currency: "EUR" }), metricSpec),
    ).toThrow();
  });
});

describe("carry cursor encoding", () => {
  it("round-trips records, bigints and unknown markers without request-derived fields", () => {
    const carry: Carry = new Map();
    addToCarry(carry, other({ rawPlacement: "a", spendMicros: 1n, reactions: 1 }), metricSpec);
    addToCarry(carry, other({ rawPlacement: "b", spendMicros: 2n }), metricSpec);
    const encoded = encodeCarry(carry, metricSpec);
    expect(JSON.stringify(encoded)).not.toContain("accountExternalId");
    expect(encoded).toEqual([
      {
        r: {
          entityExternalId: "4004",
          date: "2026-03-02",
          placement: "other",
          currency: "USD",
          rawPlacement: "a,b",
          spendMicros: "3",
        },
        u: ["reactions"],
      },
    ]);
    const decoded = decodeCarry(JSON.parse(JSON.stringify(encoded)), metricSpec, derived);
    // The unknown marker survives: a later contribution with reactions stays unknown.
    addToCarry(decoded, other({ rawPlacement: "c", spendMicros: 4n, reactions: 5 }), metricSpec);
    const [row] = takeFromCarry(decoded, 10);
    expect(row).toEqual(other({ rawPlacement: "a,b,c", spendMicros: 7n }));
  });

  it.each([
    ["not a list", {}],
    ["bad entry", [1]],
    [
      "bad amount",
      [{ r: { entityExternalId: "1", date: "d", placement: "other", spendMicros: "-1" } }],
    ],
    ["unknown non-additive field", [{ r: { entityExternalId: "1" }, u: ["currency"] }]],
    ["derived field", [{ r: { accountExternalId: "1" } }]],
    [
      "duplicate key",
      [
        { r: { entityExternalId: "1", date: "d", placement: "other" } },
        { r: { entityExternalId: "1", date: "d", placement: "other" } },
      ],
    ],
  ])("rejects a malformed carry: %s", (_label, encoded) => {
    expect(() => decodeCarry(encoded, metricSpec, derived)).toThrow();
  });

  it("flushes in order, at most the requested count", () => {
    const carry: Carry = new Map();
    for (const day of ["01", "02", "03"]) {
      addToCarry(carry, other({ date: `2026-03-${day}`, impressions: 1 }), metricSpec);
    }
    expect(takeFromCarry(carry, 2).map((r) => r.date)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(carry.size).toBe(1);
  });
});
