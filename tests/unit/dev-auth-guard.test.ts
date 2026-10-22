// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEV_ISSUER as BACKEND_DEV_ISSUER } from "@/convex/lib/authIssuers";
import { DEPLOYMENT_COMMANDS, DEV_ISSUER, mergeDevIssuer } from "../../scripts/dev-auth.mjs";
import {
  assertLocalConvexTarget,
  assertLoopbackUrl,
  LocalGuardError,
  parseDeploymentLabel,
} from "../../scripts/local-convex-guard.mjs";

// Audit finding H1: dev-auth and dev-seed only ever change the developer's LOCAL deployment,
// and dev-auth merges AUTH_ISSUERS instead of replacing it (the Clerk entry survives).

function fakeCli(output: string) {
  return () => ({ status: 1, stdout: "", stderr: output });
}

describe("parseDeploymentLabel", () => {
  it("reads the single deployment label", () => {
    expect(
      parseDeploymentLabel(
        "Environment variable X not found (on local deployment local-acme_marketing)",
      ),
    ).toEqual({ type: "local", name: "local-acme_marketing" });
  });

  it("refuses zero or several labels", () => {
    expect(parseDeploymentLabel("no label here")).toBeNull();
    expect(
      parseDeploymentLabel("(on local deployment a-1) (on prod deployment steady-loris-267)"),
    ).toBeNull();
  });
});

describe("assertLocalConvexTarget", () => {
  it.each([
    ["the local deployment", "(on local deployment local-vishesh_t-marketing_microservice)"],
    ["an anonymous local deployment", "(on anonymous deployment anonymous-agent)"],
  ])("accepts %s", (_label, output) => {
    expect(assertLocalConvexTarget(fakeCli(`not found ${output}`))).toMatch(/\w/);
  });

  it.each([
    ["production", "(on prod deployment steady-loris-267)"],
    ["a cloud dev deployment", "(on dev deployment happy-otter-123)"],
    ["a preview deployment", "(on preview deployment feat-x-123)"],
    ["an unknown target", "something went wrong"],
    ["an ambiguous target", "(on local deployment a-1) (on prod deployment b-2)"],
  ])("refuses %s", (_label, output) => {
    expect(() => assertLocalConvexTarget(fakeCli(output))).toThrow(LocalGuardError);
  });
});

describe("assertLoopbackUrl", () => {
  it.each(["http://127.0.0.1:3210", "http://localhost:3210", "http://[::1]:3210"])(
    "accepts %s",
    (url) => {
      expect(() => assertLoopbackUrl(url)).not.toThrow();
    },
  );

  it.each(["https://steady-loris-267.convex.cloud", "http://192.168.1.5:3210", "not a url", ""])(
    "refuses %j",
    (url) => {
      expect(() => assertLoopbackUrl(url)).toThrow(LocalGuardError);
    },
  );
});

describe("mergeDevIssuer", () => {
  const dev = { issuer: DEV_ISSUER, jwks: "data:new", applicationID: "marketing-service" };
  const clerk = {
    issuer: "https://example-app.clerk.accounts.test",
    jwks: "https://example-app.clerk.accounts.test/.well-known/jwks.json",
    applicationID: "convex",
  };

  it("adds the dev issuer to an unset or empty value", () => {
    expect(JSON.parse(mergeDevIssuer(undefined, dev))).toEqual([dev]);
    expect(JSON.parse(mergeDevIssuer("", dev))).toEqual([dev]);
    expect(JSON.parse(mergeDevIssuer("[]", dev))).toEqual([dev]);
  });

  it("keeps every other issuer (the Clerk development instance) and replaces the old dev entry", () => {
    const current = JSON.stringify([{ ...dev, jwks: "data:old" }, clerk]);
    expect(JSON.parse(mergeDevIssuer(current, dev))).toEqual([clerk, dev]);
  });

  it.each(["{", "{}", '"[]"', "42"])("refuses to overwrite an unreadable value (%s)", (raw) => {
    expect(() => mergeDevIssuer(raw, dev)).toThrow(/never overwritten/);
  });
});

describe("dev-auth commands", () => {
  it("guards exactly the commands that write to a deployment", () => {
    expect([...DEPLOYMENT_COMMANDS].sort()).toEqual(["apply", "encryption-key", "seed", "setup"]);
    for (const offline of ["keys", "env", "token"])
      expect(DEPLOYMENT_COMMANDS.has(offline)).toBe(false);
  });

  it("uses the same dev issuer the backend refuses on cloud deployments", () => {
    expect(DEV_ISSUER).toBe(BACKEND_DEV_ISSUER);
  });
});
