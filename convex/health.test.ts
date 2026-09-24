import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { SERVICE_NAME } from "./health";
import { modules } from "./test.setup";

describe("health.ping", () => {
  it("responds without authentication", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(api.health.ping, {});

    expect(result).toEqual({ ok: true, service: SERVICE_NAME });
  });
});
