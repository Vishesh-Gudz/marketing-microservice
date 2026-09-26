import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import { describeError } from "./errors";

describe("describeError", () => {
  it("recognises the analytics read budget", () => {
    const error = apiError("INVALID_ARGUMENT", "Too many rows.", {
      reason: "too_many_rows",
      maxRows: 8000,
      budget: "metrics",
    });
    expect(describeError(error)).toMatchObject({ kind: "too_many_rows", retryable: false });
  });

  it("maps contract codes", () => {
    expect(describeError(apiError("NOT_FOUND", "x")).kind).toBe("not_found");
    expect(describeError(apiError("INVALID_ARGUMENT", "x")).kind).toBe("invalid_argument");
    expect(describeError(apiError("UNAUTHENTICATED", "x")).kind).toBe("unauthenticated");
    expect(describeError(apiError("FORBIDDEN", "x")).kind).toBe("forbidden");
    expect(describeError(apiError("ORG_NOT_PROVISIONED", "x")).kind).toBe("org_not_provisioned");
    expect(describeError(apiError("INTERNAL", "x")).kind).toBe("unknown");
  });

  it("never shows messages of unexpected errors", () => {
    const described = describeError(new Error("secret internal detail"));
    expect(described.kind).toBe("unknown");
    expect(JSON.stringify(described)).not.toContain("secret");
  });
});
