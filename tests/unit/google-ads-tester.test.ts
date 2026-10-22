// @vitest-environment node
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  CONVEX_SELECTION_ENV_VARS,
  convexChildEnv,
  parseArgs,
  pickConnection,
} from "../../scripts/google-ads-tester.mjs";
import {
  accountSyncLines,
  connectionLines,
  microsToDecimal,
} from "../../scripts/google-ads-tester/format.mjs";
import {
  GuardError,
  IDENTITY_PROBE,
  parseConfig,
  parseIdentity,
  VALIDATION_ROLE,
  verifyDeployment,
} from "../../scripts/google-ads-tester/guard.mjs";
import { loopbackReturnUrl, startOneTimeRedirect } from "../../scripts/google-ads-tester/oauth.mjs";
import { createOutput, redact } from "../../scripts/google-ads-tester/redact.mjs";
import {
  confirmationMatches,
  describeAssetLine,
  selectForLink,
} from "../../scripts/google-ads-tester/select.mjs";

// The Google Ads tester (dev / validation tooling): fail-closed deployment guard, opt-in
// exactly-one linking with typed confirmation, literal unknown statuses, redaction of every
// printed line, the one-time loopback redirect and strict argument parsing. No network and
// no Convex CLI: the CLI runner is a fake.

// Placeholder deployment names (never real deployments); they only need the name shape.
const DEV = "fake-validation-101";
const PROD = "fake-production-202";
const CONFIG = { validationDeployment: DEV, org: "gads-validation" };
const ISSUERS = JSON.stringify([
  {
    issuer: "https://dev-issuer.marketing.local",
    jwks: "data:x",
    applicationID: "marketing-service",
  },
]);

type RunResult = { status: number; stdout: string; stderr: string };
type FakeCli = {
  env?: Record<string, string | undefined>;
  target?: string;
  prod?: string;
};

function fakeCli(options: FakeCli = {}) {
  const env: Record<string, string | undefined> = {
    DEPLOYMENT_ROLE: VALIDATION_ROLE,
    AUTH_ISSUERS: ISSUERS,
    GOOGLE_CLIENT_ID: "123456789012-abcdefghij.apps.googleusercontent.com",
    PROVIDER_MODE: undefined,
    ...options.env,
  };
  const calls: string[][] = [];
  const notFound = (name: string, label: string): RunResult => ({
    status: 1,
    stdout: "",
    stderr: `✖ Environment variable "${name}" not found ${label}`,
  });
  const run = (args: string[]): RunResult => {
    calls.push(args);
    const name = args[2]!;
    if (name === IDENTITY_PROBE) {
      return args.includes("--prod")
        ? notFound(name, options.prod ?? `(on prod deployment ${PROD})`)
        : notFound(name, options.target ?? `(on dev deployment ${DEV})`);
    }
    const value = env[name];
    return value === undefined
      ? notFound(name, `(on dev deployment ${DEV})`)
      : { status: 0, stdout: `${value}\n`, stderr: "" };
  };
  return { run, calls };
}

function verify(requested: string | undefined, cli = fakeCli(), config = CONFIG) {
  return verifyDeployment({ requested, config, runConvex: cli.run });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GuardError);
    return (error as GuardError).step;
  }
  throw new Error("expected a refusal");
}

describe("deployment guard (fails closed)", () => {
  it("accepts only the allowlisted dev deployment and derives its URLs from the verified name", () => {
    const cli = fakeCli({ env: { PROVIDER_MODE: "live" } });
    expect(verify(DEV, cli)).toEqual({
      deployment: DEV,
      cloudUrl: `https://${DEV}.convex.cloud`,
      siteUrl: `https://${DEV}.convex.site`,
      providerMode: "live",
      productionDeployment: PROD,
      org: "gads-validation",
    });
    // Never lists env values, never reads the client secret.
    expect(cli.calls.some((args) => args.includes("list"))).toBe(false);
    expect(cli.calls.some((args) => args.includes("GOOGLE_CLIENT_SECRET"))).toBe(false);
    // Every call names its target explicitly.
    expect(
      cli.calls.every((args) => args.includes("--deployment") || args.includes("--prod")),
    ).toBe(true);
  });

  it.each([
    ["no --deployment", undefined, "argument"],
    ["the prod reference", "prod", "argument"],
    ["the local reference", "local", "argument"],
    ["a URL", `https://${DEV}.convex.cloud`, "argument"],
    ["a loopback address", "127.0.0.1:3210", "argument"],
    ["a deployment that is not allowlisted", "happy-otter-123", "allowlist"],
  ])("refuses %s", (_label, requested, step) => {
    expect(refusal(() => verify(requested))).toBe(step);
  });

  it("refuses when the CLI reports a production (or any non-dev) deployment", () => {
    expect(refusal(() => verify(DEV, fakeCli({ target: `(on prod deployment ${DEV})` })))).toBe(
      "identity",
    );
    expect(refusal(() => verify(DEV, fakeCli({ target: `(on preview deployment ${DEV})` })))).toBe(
      "identity",
    );
  });

  it("refuses when the CLI identity is another deployment, missing or ambiguous", () => {
    expect(
      refusal(() => verify(DEV, fakeCli({ target: "(on dev deployment other-name-1)" }))),
    ).toBe("identity");
    expect(refusal(() => verify(DEV, fakeCli({ target: "" })))).toBe("identity");
    expect(
      refusal(() =>
        verify(DEV, fakeCli({ target: `(on dev deployment ${DEV}) (on dev deployment ${DEV})` })),
      ),
    ).toBe("identity");
  });

  it("refuses when production cannot be resolved or is the target", () => {
    expect(refusal(() => verify(DEV, fakeCli({ prod: "" })))).toBe("production");
    expect(refusal(() => verify(DEV, fakeCli({ prod: `(on prod deployment ${DEV})` })))).toBe(
      "production",
    );
  });

  it.each([
    ["no role marker", { DEPLOYMENT_ROLE: undefined }, "role"],
    ["another role", { DEPLOYMENT_ROLE: "staging" }, "role"],
    ["no dev issuer", { AUTH_ISSUERS: "[]" }, "config"],
    ["malformed issuers", { AUTH_ISSUERS: "{nope" }, "config"],
    ["no Google client id", { GOOGLE_CLIENT_ID: undefined }, "config"],
    ["a malformed Google client id", { GOOGLE_CLIENT_ID: "not-a-client" }, "config"],
  ])("refuses with %s", (_label, env, step) => {
    expect(refusal(() => verify(DEV, fakeCli({ env })))).toBe(step);
  });

  it("validates the local allowlist file", () => {
    expect(parseConfig(JSON.stringify({ validationDeployment: DEV }))).toEqual(CONFIG);
    for (const text of [
      "{",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ validationDeployment: "https://x.convex.cloud" }),
      JSON.stringify({ validationDeployment: DEV, org: "bad org!" }),
    ]) {
      expect(() => parseConfig(text)).toThrow(GuardError);
    }
  });

  it("parses exactly one CLI identity label", () => {
    expect(parseIdentity(`x (on dev deployment ${DEV}) y`)).toEqual({ type: "dev", name: DEV });
    expect(parseIdentity("nothing here")).toBeNull();
  });
});

const ASSETS = [
  {
    externalId: "1110000001",
    name: "Test Manager",
    status: "closed",
    isManager: true,
    managerStatus: "manager",
    testAccountStatus: "test",
    linked: false,
  },
  {
    externalId: "2220000001",
    name: "Client A",
    status: "closed",
    isManager: false,
    managerStatus: "client",
    testAccountStatus: "test",
    parentExternalId: "1110000001",
    linked: false,
  },
  {
    externalId: "2220000002",
    name: "Client B",
    status: "active",
    isManager: false,
    managerStatus: "client",
    testAccountStatus: "unknown",
    parentExternalId: "1110000001",
    linked: false,
  },
  {
    externalId: "2220000003",
    name: "Client C",
    status: "active",
    isManager: false,
    managerStatus: "client",
    testAccountStatus: "not_test",
    linked: false,
  },
  {
    externalId: "7770000001",
    name: "Direct",
    status: "active",
    isManager: false,
    managerStatus: "unknown",
    testAccountStatus: "not_test",
    linked: false,
  },
  {
    externalId: "8880000001",
    name: "Already",
    status: "active",
    isManager: false,
    managerStatus: "client",
    testAccountStatus: "test",
    linked: true,
  },
];

describe("opt-in, exactly-one linking", () => {
  it("shows the exact customer id, relation and literal statuses", () => {
    expect(describeAssetLine(ASSETS[1])).toBe(
      '222-000-0001 | "Client A" | type=client | relation=client of manager 111-000-0001 | testAccountStatus=test | status=closed | not linked',
    );
    expect(describeAssetLine(ASSETS[2])).toContain("testAccountStatus=unknown");
    expect(describeAssetLine(ASSETS[4])).toContain(
      "type=unknown (not reported by Google; not linkable)",
    );
    expect(describeAssetLine(ASSETS[4])).toContain("relation=directly accessible");
  });

  it("selects one confirmed test client (dashes allowed)", () => {
    expect(selectForLink(ASSETS, "222-000-0001")).toEqual({
      ok: true,
      asset: ASSETS[1],
      warnings: [],
    });
  });

  it.each([
    ["a manager", "1110000001", "manager_not_linkable"],
    ["an unknown manager status", "7770000001", "manager_status_unknown"],
    ["an account not discovered", "9990000001", "not_discovered"],
    ["an already linked account", "8880000001", "already_linked"],
    ["a malformed id", "12345", "invalid_customer_id"],
    ["two ids", "2220000001,2220000002", "one_account_only"],
    ["an unknown test status without acknowledgement", "2220000002", "not_confirmed_test_account"],
    ["a non-test account without acknowledgement", "2220000003", "not_confirmed_test_account"],
  ])("refuses %s", (_label, id, reason) => {
    expect(selectForLink(ASSETS, id)).toMatchObject({ ok: false, reason });
  });

  it("names the unknown status and the flag, never treating unknown as test or not_test", () => {
    const result = selectForLink(ASSETS, "2220000002");
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('"unknown"');
  });

  it("--allow-non-test-account only acknowledges; it never unlocks managers or unknown types", () => {
    const ack = selectForLink(ASSETS, "2220000002", { allowNonTestAccount: true });
    expect(ack).toMatchObject({ ok: true });
    expect((ack as { warnings: string[] }).warnings[0]).toMatch(
      /acknowledgement only; Google API access restrictions still apply/,
    );
    expect(selectForLink(ASSETS, "7770000001", { allowNonTestAccount: true })).toMatchObject({
      ok: false,
      reason: "manager_status_unknown",
    });
    expect(selectForLink(ASSETS, "1110000001", { allowNonTestAccount: true })).toMatchObject({
      ok: false,
      reason: "manager_not_linkable",
    });
  });

  it("requires the exact customer id to be typed", () => {
    const asset = ASSETS[1]!;
    expect(confirmationMatches("2220000001", asset)).toBe(true);
    expect(confirmationMatches(" 222-000-0001 ", asset)).toBe(true);
    for (const typed of ["", "y", "yes", "2220000002", "222000000", "2220000001 2220000001"]) {
      expect(confirmationMatches(typed, asset), typed).toBe(false);
    }
  });
});

describe("redaction of every printed line", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlLXZhbHVl";
  it.each([
    ["a JWT", `token ${jwt} here`, jwt],
    ["a bearer token", "Authorization: Bearer abc.def", "abc.def"],
    [
      "an OAuth URL",
      "go to https://accounts.google.com/o/oauth2/v2/auth?client_id=1&state=s3cr3t",
      "s3cr3t",
    ],
    ["a state parameter", "http://localhost:3000/?state=abc123&code=4/xyz", "abc123"],
    ["an authorization code", "callback?code=4/0AbCdEf", "4/0AbCdEf"],
    ["a client secret", "GOCSPX-abcdefghijklmnop", "abcdefghijklmnop"],
    ["an access token", "ya29.a0AfH6SMBx", "a0AfH6SMBx"],
    ["a refresh token", "1//0gAbCdEfGhIjKlMn", "0gAbCdEfGhIjKlMn"],
    ["a deploy key", `dev:${DEV}|eyJ2MiI6Im`, "eyJ2MiI6Im"],
    ["a private key", "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "MIIabc"],
    ["an email", "signed in as someone@example.com", "someone@example.com"],
  ])("removes %s", (_label, input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it("keeps ordinary diagnostics readable", () => {
    const line = `redirect_uri verified: https://${DEV}.convex.site/oauth/callback`;
    expect(redact(line)).toBe(line);
    expect(redact("222-000-0001 | testAccountStatus=unknown")).toBe(
      "222-000-0001 | testAccountStatus=unknown",
    );
  });

  it("the output writer redacts every line", () => {
    const written: string[] = [];
    const out = createOutput((chunk: string) => {
      written.push(chunk);
      return true;
    });
    out.line("token", jwt);
    out.line("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    const text = written.join("");
    expect(text).not.toContain(jwt);
    expect(text).not.toContain("state=abc");
    expect(written).toHaveLength(2);
  });
});

describe("status and report formatting", () => {
  it("prints exact money and the allowlisted sync reason", () => {
    expect(microsToDecimal("1234567")).toBe("1.234567");
    expect(microsToDecimal("5000000")).toBe("5");
    expect(microsToDecimal("123")).toBe("0.000123");
    const lines = accountSyncLines([
      {
        platform: "google_ads",
        externalId: "2220000001",
        name: "Client A",
        linked: true,
        sync: {
          syncState: "idle",
          lastRunStatus: "failed",
          consecutiveFailures: 1,
          lastError: {
            kind: "unknown",
            reason: "cloud_project_not_approved_for_production",
            message: "Unexpected platform error",
            at: "2026-03-08T00:00:00.000Z",
          },
        },
      },
    ]);
    expect(lines[0]).toContain("lastError=unknown (cloud_project_not_approved_for_production)");
    expect(
      connectionLines([
        {
          id: "c1",
          provider: "google_ads",
          status: "active",
          missingScopes: [],
          expiresSoon: false,
        },
      ])[0],
    ).toBe("connection c1 | provider=google_ads | status=active | missingScopes=none");
  });
});

describe("one-time loopback redirect", () => {
  function get(port: number, path: string, host = `127.0.0.1:${port}`) {
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location ? { location: res.headers.location } : {}),
            body,
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("redirects exactly once on the exact loopback host and refuses other hosts", async () => {
    const port = 47_000 + Math.floor(Math.random() * 1_000);
    const target = "https://accounts.google.com/o/oauth2/v2/auth?state=unit-test";
    const redirect = startOneTimeRedirect(target, { port });
    await redirect.listening;
    expect(redirect.startUrl).toBe(`http://127.0.0.1:${port}/start`);
    expect((await get(port, "/start", `evil.example:${port}`)).status).toBe(421);
    expect(await get(port, "/start")).toMatchObject({ status: 302, location: target });
    expect(redirect.served).toBe(true);
    expect((await get(port, "/start")).status).toBe(410);
    await redirect.close().catch(() => undefined);
  });

  it("accepts the OAuth return once, after /start only, without echoing it (S2)", async () => {
    const port = 48_000 + Math.floor(Math.random() * 1_000);
    expect(loopbackReturnUrl(port)).toBe(`http://127.0.0.1:${port}/return`);
    const claim = "c".repeat(43);
    const redirect = startOneTimeRedirect("https://accounts.google.com/o/oauth2/v2/auth", {
      port,
    });
    await redirect.listening;
    // Before the redirect was served, a return is refused.
    expect((await get(port, `/return?status=pending&claim=${claim}`)).status).toBe(410);
    await get(port, "/start");
    expect(
      (await get(port, `/return?status=pending&claim=${claim}`, `evil.example:${port}`)).status,
    ).toBe(421);
    const returned = await get(port, `/return?status=pending&claim=${claim}&extra=x`);
    expect(returned.status).toBe(200);
    expect(returned.body).not.toContain(claim);
    await expect(redirect.result).resolves.toEqual({
      status: "pending",
      claim,
      error: undefined,
    });
    await redirect.close().catch(() => undefined);
  });
});

describe("arguments and connection choice", () => {
  it("accepts only known commands and flags", () => {
    expect(COMMANDS).toEqual(["guard-check", "connect", "discover", "link", "status", "report"]);
    expect(parseArgs(["link", "--deployment", DEV, "--customer", "2220000001"])).toEqual({
      command: "link",
      flags: { deployment: DEV, customer: "2220000001" },
    });
    for (const argv of [
      ["deploy"],
      ["status", "--url", "https://x"],
      ["status", "--deployment"],
      ["status", "--deployment", DEV, "--deployment", DEV],
      ["report", "--days", "0"],
      ["link", "extra"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("acts on the newest active Google connection unless one is named", () => {
    const connections = [
      { id: "m1", provider: "meta", status: "active", connectedAt: "2026-03-09T00:00:00.000Z" },
      {
        id: "g1",
        provider: "google_ads",
        status: "active",
        connectedAt: "2026-03-07T00:00:00.000Z",
      },
      {
        id: "g2",
        provider: "google_ads",
        status: "active",
        connectedAt: "2026-03-08T00:00:00.000Z",
      },
      {
        id: "g3",
        provider: "google_ads",
        status: "needs_reauth",
        connectedAt: "2026-03-09T00:00:00.000Z",
      },
    ];
    expect(pickConnection(connections).id).toBe("g2");
    expect(pickConnection(connections, "g1").id).toBe("g1");
    expect(() => pickConnection(connections, "m1")).toThrow();
    expect(() => pickConnection([])).toThrow();
  });
});

describe("Convex CLI child environment", () => {
  it("strips exactly the deployment selection, authentication and control-plane variables", () => {
    expect(CONVEX_SELECTION_ENV_VARS).toEqual([
      "CONVEX_DEPLOY_KEY",
      "CONVEX_DEPLOYMENT_TOKEN",
      "CONVEX_SELF_HOSTED_URL",
      "CONVEX_SELF_HOSTED_ADMIN_KEY",
      "CONVEX_DEPLOYMENT",
      "CONVEX_PROVISION_HOST",
      "CONVEX_OVERRIDE_ACCESS_TOKEN",
    ]);
  });

  it("drops every deployment-selecting variable and keeps the rest", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CONVEX_DEPLOY_KEY: "placeholder",
      CONVEX_DEPLOYMENT_TOKEN: "placeholder",
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:9",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "placeholder",
      CONVEX_DEPLOYMENT: "dev:fake-other-303",
      CONVEX_PROVISION_HOST: "http://127.0.0.1:9",
      CONVEX_OVERRIDE_ACCESS_TOKEN: "placeholder",
      CONVEX_AGENT_MODE: "anonymous",
    };
    const child = convexChildEnv(env);
    expect(Object.keys(child).sort()).toEqual(["CONVEX_AGENT_MODE", "HOME", "PATH"]);
    for (const name of CONVEX_SELECTION_ENV_VARS) expect(child).not.toHaveProperty(name);
  });

  it("matches names case-insensitively (Windows environment names)", () => {
    const child = convexChildEnv({
      Convex_Self_Hosted_Url: "http://127.0.0.1:9",
      convex_provision_host: "http://127.0.0.1:9",
      Convex_Override_Access_Token: "placeholder",
      Path: "C:\\",
    });
    expect(child).toEqual({ Path: "C:\\" });
  });

  it("returns a copy and never modifies the caller's environment", () => {
    const env = {
      CONVEX_DEPLOYMENT: "dev:fake-other-303",
      CONVEX_PROVISION_HOST: "http://127.0.0.1:9",
      CONVEX_OVERRIDE_ACCESS_TOKEN: "placeholder",
      PATH: "/usr/bin",
    };
    const before = { ...env };
    const child = convexChildEnv(env);
    expect(env).toEqual(before);
    expect(child).toEqual({ PATH: "/usr/bin" });
    expect(child).not.toBe(env);
  });
});
