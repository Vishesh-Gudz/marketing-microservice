import { describe, expect, it } from "vitest";
import { createDevTokenSource } from "./token-source";

describe("createDevTokenSource", () => {
  it("serves the dev token outside production", async () => {
    const source = createDevTokenSource("jwt", "development");
    expect(source?.kind).toBe("dev");
    await expect(source?.getToken({ forceRefreshToken: false })).resolves.toBe("jwt");
  });

  it("is disabled in production builds", () => {
    expect(createDevTokenSource("jwt", "production")).toBeNull();
  });

  it("is disabled when no token is configured", () => {
    expect(createDevTokenSource(undefined, "development")).toBeNull();
    expect(createDevTokenSource("", "development")).toBeNull();
  });
});
