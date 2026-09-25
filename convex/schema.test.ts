import { describe, expect, it } from "vitest";
import type { Doc } from "./_generated/dataModel";
import type { TenantTable } from "./lib/tenancy";
import schema from "./schema";

// Schema invariants, checked by introspecting the real schema definition
// (validator JSON + declared indexes) rather than a hand-maintained copy.

type FieldJson = { fieldType: { type: string; tableName?: string }; optional: boolean };
type TableIntrospection = {
  validator: { json: { type: string; value: Record<string, FieldJson> } };
  " indexes"(): { indexDescriptor: string; fields: string[] }[];
};

const tables = schema.tables as unknown as Record<string, TableIntrospection>;
const tableNames = Object.keys(tables).sort();

/** Tables without an owner: the tenancy roots themselves. */
const GLOBAL_TABLES = ["integrationApps", "organizations"];

/**
 * The ONLY indexes on tenant tables that may not start with orgId: the
 * unauthenticated OAuth callback and the system health sweep (Phase 4), and
 * the sync planner's due-account index (Phase 5; rows re-verified on read).
 */
const APPROVED_GLOBAL_INDEXES = [
  "connections.by_status_expires",
  "oauthStates.by_expires",
  "oauthStates.by_nonce_hash",
  "syncAccounts.by_next_plan",
];
const tenantTables = tableNames.filter((name) => !GLOBAL_TABLES.includes(name));

function fields(table: string) {
  return tables[table]!.validator.json.value;
}

function indexes(table: string) {
  return tables[table]![" indexes"]();
}

describe("schema inventory", () => {
  it("contains exactly the Phase 1, 2, 4 and 5 tables", () => {
    expect(tableNames).toEqual(
      [
        "connections",
        "credentials",
        "discoveredAssets",
        "oauthStates",
        "actionMetricsDaily",
        "adAccounts",
        "adGroups",
        "ads",
        "auditLog",
        "campaigns",
        "creatives",
        "integrationApps",
        "metricsDaily",
        "organizations",
        "socialAccountMetricsDaily",
        "socialAccounts",
        "socialPostMetricSnapshots",
        "socialPosts",
        "syncAccounts",
        "syncRuns",
        "syncTasks",
      ].sort(),
    );
  });

  it("declares the approved indexes", () => {
    const declared = Object.fromEntries(
      tableNames.map((name) => [
        name,
        Object.fromEntries(indexes(name).map((i) => [i.indexDescriptor, i.fields])),
      ]),
    );
    expect(declared).toMatchSnapshot();
  });
});

describe("tenant ownership", () => {
  it.each(tenantTables)("%s has a required orgId referencing organizations", (table) => {
    expect(fields(table).orgId).toEqual({
      fieldType: { type: "id", tableName: "organizations" },
      optional: false,
    });
  });

  it.each(tenantTables)(
    "every index on %s starts with orgId (or is an approved global index)",
    (table) => {
      for (const index of indexes(table)) {
        if (APPROVED_GLOBAL_INDEXES.includes(`${table}.${index.indexDescriptor}`)) continue;
        expect(index.fields[0], `${table}.${index.indexDescriptor}`).toBe("orgId");
      }
    },
  );

  it("has exactly the approved global indexes", () => {
    const global = tenantTables.flatMap((table) =>
      indexes(table)
        .filter((index) => index.fields[0] !== "orgId")
        .map((index) => `${table}.${index.indexDescriptor}`),
    );
    expect(global.sort()).toEqual(APPROVED_GLOBAL_INDEXES);
  });

  it("global tables do not carry orgId", () => {
    for (const table of GLOBAL_TABLES) expect(fields(table).orgId).toBeUndefined();
  });

  it("every tenant table is accepted by getOwned (TenantTable)", () => {
    // Compile-time check: this assignment fails typechecking if any table lacks orgId.
    const owned: TenantTable[] = [
      "auditLog",
      "adAccounts",
      "campaigns",
      "adGroups",
      "ads",
      "creatives",
      "metricsDaily",
      "actionMetricsDaily",
      "socialAccounts",
      "socialPosts",
      "socialPostMetricSnapshots",
      "socialAccountMetricsDaily",
      "connections",
      "credentials",
      "oauthStates",
      "discoveredAssets",
      "syncAccounts",
      "syncRuns",
      "syncTasks",
    ];
    expect([...owned].sort()).toEqual(tenantTables);
  });
});

describe("value conventions", () => {
  const allFields = tableNames.flatMap((table) =>
    Object.entries(fields(table)).map(([name, field]) => ({ table, name, field })),
  );

  it("stores every money field (*Micros) as int64", () => {
    const money = allFields.filter((f) => f.name.endsWith("Micros"));
    expect(money.map((f) => `${f.table}.${f.name}`).sort()).toEqual([
      "actionMetricsDaily.valueMicros",
      "adGroups.budgetMicros",
      "campaigns.budgetMicros",
      "metricsDaily.conversionValueMicros",
      "metricsDaily.spendMicros",
    ]);
    for (const { table, name, field } of money) {
      expect(field.fieldType.type, `${table}.${name}`).toBe("bigint");
    }
  });

  it("stores credential material only as bytes in the credentials table", () => {
    const bytes = allFields.filter((f) => f.field.fieldType.type === "bytes");
    expect(bytes.map((f) => `${f.table}.${f.name}`).sort()).toEqual([
      "credentials.ciphertext",
      "credentials.iv",
    ]);
  });

  it("uses int64 only for money", () => {
    const bigints = allFields.filter((f) => f.field.fieldType.type === "bigint");
    expect(bigints.every((f) => f.name.endsWith("Micros"))).toBe(true);
  });

  it("stores calendar dates as strings", () => {
    const dates = allFields.filter((f) => f.name === "date" || f.name.endsWith("Date"));
    expect(dates.length).toBeGreaterThanOrEqual(6);
    for (const { table, name, field } of dates) {
      expect(field.fieldType.type, `${table}.${name}`).toBe("string");
    }
  });

  it("stores instants (*At) as numbers", () => {
    for (const { table, name, field } of allFields.filter((f) => f.name.endsWith("At"))) {
      expect(field.fieldType.type, `${table}.${name}`).toBe("number");
    }
  });

  it("keeps external ids as strings", () => {
    for (const { table, name, field } of allFields.filter((f) =>
      /ExternalId$|^externalId$/.test(f.name),
    )) {
      expect(field.fieldType.type, `${table}.${name}`).toBe("string");
    }
  });
});

describe("generated types", () => {
  type Equals<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const assert = <T extends true>(value: T) => value;

  it("maps money to bigint and dates to string in Doc types", () => {
    assert<Equals<Doc<"metricsDaily">["spendMicros"], bigint | undefined>>(true);
    assert<Equals<Doc<"campaigns">["budgetMicros"], bigint | undefined>>(true);
    assert<Equals<Doc<"actionMetricsDaily">["valueMicros"], bigint | undefined>>(true);
    assert<Equals<Doc<"metricsDaily">["date"], string>>(true);
    assert<Equals<Doc<"metricsDaily">["placement"], Doc<"actionMetricsDaily">["placement"]>>(true);
    assert<Equals<Doc<"adAccounts">["platform"], "meta" | "google_ads">>(true);
    assert<Equals<Doc<"socialAccounts">["platform"], "instagram" | "facebook">>(true);
    expect(true).toBe(true);
  });
});
