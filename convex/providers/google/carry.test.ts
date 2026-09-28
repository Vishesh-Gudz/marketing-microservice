import { describe, expect, it } from "vitest";
import {
  addToCarry,
  decodeCarry,
  encodeCarry,
  takeFromCarry,
  type Carry,
  type CarrySpec,
} from "./carry";

// Phase 9 (G-D11 = A): the Google-local carry keeps the Phase 8 semantics — exact sums when
// every contribution reported a field, absent otherwise, identity fields must agree.

const spec: CarrySpec = {
  key: (r) => [r.entityExternalId, r.date, r.placement].join("|"),
  accumulates: (r) => r.placement === "other",
  additive: ["impressions", "clicks", "spendMicros"],
  bigints: ["spendMicros"],
  derived: ["platform", "accountExternalId", "level"],
};
const derived = { platform: "google_ads", accountExternalId: "2220000001", level: "campaign" };
const other = (fields: Record<string, unknown>) => ({
  ...derived,
  entityExternalId: "10000000001",
  date: "2026-03-02",
  placement: "other",
  currency: "USD",
  ...fields,
});

function merge(...records: Record<string, unknown>[]) {
  const carry: Carry = new Map();
  for (const record of records) addToCarry(carry, record, spec);
  return takeFromCarry(carry, 100);
}

describe("Google carry", () => {
  it("sums fields every contribution reported; explicit 0 stays 0", () => {
    expect(
      merge(
        other({ rawPlacement: "GOOGLE_TV", impressions: 5, clicks: 0, spendMicros: 10n }),
        other({ rawPlacement: "UNKNOWN", impressions: 7, clicks: 0, spendMicros: 5n }),
      ),
    ).toEqual([
      other({ rawPlacement: "GOOGLE_TV,UNKNOWN", impressions: 12, clicks: 0, spendMicros: 15n }),
    ]);
  });

  it("keeps a field absent when none or only some contributions reported it", () => {
    const [row] = merge(
      other({ rawPlacement: "a", impressions: 1 }),
      other({ rawPlacement: "b", impressions: 2, clicks: 3 }),
    );
    expect(row!.impressions).toBe(3);
    expect(row).not.toHaveProperty("clicks");
    expect(row).not.toHaveProperty("spendMicros");
  });

  it("rejects inconsistent identity fields", () => {
    const carry: Carry = new Map();
    addToCarry(carry, other({ impressions: 1 }), spec);
    expect(() => addToCarry(carry, other({ impressions: 1, currency: "EUR" }), spec)).toThrow();
  });

  it("round-trips through the cursor form, keeping unknown markers", () => {
    const carry: Carry = new Map();
    addToCarry(carry, other({ rawPlacement: "a", spendMicros: 1n, clicks: 1 }), spec);
    addToCarry(carry, other({ rawPlacement: "b", spendMicros: 2n }), spec);
    const encoded = JSON.parse(JSON.stringify(encodeCarry(carry, spec)));
    expect(JSON.stringify(encoded)).not.toContain("accountExternalId");
    const decoded = decodeCarry(encoded, spec, derived);
    addToCarry(decoded, other({ rawPlacement: "c", spendMicros: 4n, clicks: 9 }), spec);
    expect(takeFromCarry(decoded, 10)).toEqual([other({ rawPlacement: "a,b,c", spendMicros: 7n })]);
  });

  it.each([
    ["not a list", {}],
    [
      "bad amount",
      [{ r: { entityExternalId: "1", date: "d", placement: "other", spendMicros: "-1" } }],
    ],
    ["unknown non-additive field", [{ r: { entityExternalId: "1" }, u: ["currency"] }]],
    ["derived field", [{ r: { accountExternalId: "1" } }]],
  ])("rejects a malformed carry: %s", (_label, encoded) => {
    expect(() => decodeCarry(encoded, spec, derived)).toThrow();
  });
});
