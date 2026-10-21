import { describe, expect, it } from "vitest";
import { normalizeCustomer, normalizeCustomerClient } from "./normalize";

// Google's `manager` and `test_account` are `optional bool` (explicit presence) on both
// Customer (fields 27 / 28) and CustomerClient (17 / 16) in the v25 protos. A reported
// `false` is serialized; an omitted field was not reported. Three cases each, for both the
// direct (FROM customer) and the hierarchy (FROM customer_client) rows.

const base = { id: "2220000001", currencyCode: "USD", timeZone: "America/New_York" };

const CASES = [
  ["true", true, { managerStatus: "manager", isManager: true }, { testAccountStatus: "test" }],
  [
    "false",
    false,
    { managerStatus: "client", isManager: false },
    { testAccountStatus: "not_test" },
  ],
  [
    "omitted",
    undefined,
    { managerStatus: "unknown", isManager: false },
    { testAccountStatus: "unknown" },
  ],
] as const;

function fields(manager: boolean | undefined, testAccount: boolean | undefined) {
  return {
    ...base,
    ...(manager !== undefined ? { manager } : {}),
    ...(testAccount !== undefined ? { testAccount } : {}),
  };
}

describe.each([
  ["customer", (f: ReturnType<typeof fields>) => normalizeCustomer({ customer: f })],
  [
    "customer_client",
    (f: ReturnType<typeof fields>) =>
      normalizeCustomerClient({ customerClient: { ...f, level: "1" } }, "1110000001"),
  ],
] as const)("%s rows", (_label, normalize) => {
  it.each(CASES)("manager %s", (_case, value, expected) => {
    expect(normalize(fields(value, false))).toMatchObject(expected);
  });

  it.each(CASES)("test_account %s", (_case, value, _manager, expected) => {
    const record = normalize(fields(false, value));
    expect(record).toMatchObject(expected);
    // The legacy attribute is set only for an explicit true (unchanged behavior).
    expect(record.attributes?.testAccount).toBe(value === true ? "true" : undefined);
  });

  it("never turns an omitted field into a confirmed client or a non-test account", () => {
    const record = normalize(fields(undefined, undefined));
    expect(record.managerStatus).toBe("unknown");
    expect(record.testAccountStatus).toBe("unknown");
    expect(record.managerStatus).not.toBe("client");
    expect(record.testAccountStatus).not.toBe("not_test");
  });
});
