// @vitest-environment node
import type * as NodeFs from "node:fs";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, CONVEX_SELECTION_ENV_VARS, main } from "../../scripts/google-ads-tester.mjs";
import { IDENTITY_PROBE, VALIDATION_ROLE } from "../../scripts/google-ads-tester/guard.mjs";

// The tester entry point: for every command the deployment guard (allowlist file, then
// read-only `env get` probes through the Convex CLI) completes before any command-specific
// token mint, API client, request or loopback server. Everything external is a mock: the
// Convex CLI, the allowlist file, the JWT minting, the Convex client, the loopback server
// and global fetch. Deployment names are placeholders.

const DEV = "fake-validation-101";
const PROD = "fake-production-202";
const CONFIG = JSON.stringify({ validationDeployment: DEV, org: "gads-validation" });
const ISSUERS = JSON.stringify([
  { issuer: "https://dev-issuer.marketing.local", jwks: "data:x", applicationID: "marketing" },
]);

type CliReply = { status: number; stdout: string; stderr: string };

const state = vi.hoisted(() => ({
  configText: null as string | null,
  identity: "",
  env: {} as Record<string, string | undefined>,
  route: null as ((name: string) => unknown) | null,
}));

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mintToken: vi.fn(async () => "placeholder-jwt"),
  clientCreated: vi.fn(),
  request: vi.fn(),
  startOneTimeRedirect: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const isConfig = (path: unknown) => String(path).endsWith(".google-ads-tester.local.json");
  const readFileSync = actual.readFileSync as (...args: unknown[]) => unknown;
  return {
    ...actual,
    existsSync: (path: string) =>
      isConfig(path) ? state.configText !== null : actual.existsSync(path),
    readFileSync: (path: unknown, ...rest: unknown[]) =>
      isConfig(path) ? state.configText : readFileSync(path, ...rest),
  };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    constructor(url: string) {
      mocks.clientCreated(url);
    }
    setAuth() {}
    query(fn: unknown, args: unknown) {
      return mocks.request("query", fn, args);
    }
    mutation(fn: unknown, args: unknown) {
      return mocks.request("mutation", fn, args);
    }
    action(fn: unknown, args: unknown) {
      return mocks.request("action", fn, args);
    }
  },
}));

vi.mock("../../scripts/dev-auth.mjs", () => ({
  mintToken: mocks.mintToken,
}));

vi.mock("../../scripts/google-ads-tester/oauth.mjs", () => ({
  loopbackReturnUrl: (port = 4455) => `http://127.0.0.1:${port}/return`,
  startOneTimeRedirect: mocks.startOneTimeRedirect,
}));

const ARGV: Record<string, string[]> = {
  "guard-check": ["guard-check", "--deployment", DEV],
  connect: ["connect", "--deployment", DEV],
  discover: ["discover", "--deployment", DEV],
  link: ["link", "--deployment", DEV, "--customer", "2220000001"],
  status: ["status", "--deployment", DEV],
  report: ["report", "--deployment", DEV, "--days", "7"],
};

/** The Convex CLI as seen through `env get`: values print, missing names report the target. */
function cliReply(argv: string[]): CliReply {
  const [, sub, verb, name] = argv;
  if (sub !== "env" || verb !== "get" || name === undefined) {
    return { status: 1, stdout: "", stderr: "unexpected Convex CLI call" };
  }
  const label = argv.includes("--prod") ? `(on prod deployment ${PROD})` : state.identity;
  const value = name === IDENTITY_PROBE ? undefined : state.env[name];
  return value === undefined
    ? { status: 1, stdout: "", stderr: `✖ Environment variable "${name}" not found ${label}` }
    : { status: 0, stdout: `${value}\n`, stderr: "" };
}

/** Every call that must wait for the guard: token mint, client, request, loopback, fetch. */
const sensitive = () => [
  mocks.mintToken,
  mocks.clientCreated,
  mocks.request,
  mocks.startOneTimeRedirect,
  mocks.fetch,
];

let printed: string[] = [];

beforeEach(() => {
  state.configText = CONFIG;
  state.identity = `(on dev deployment ${DEV})`;
  state.env = {
    DEPLOYMENT_ROLE: VALIDATION_ROLE,
    AUTH_ISSUERS: ISSUERS,
    GOOGLE_CLIENT_ID: "123456789012-abcdefghij.apps.googleusercontent.com",
    PROVIDER_MODE: "live",
  };
  state.route = null;
  mocks.spawnSync.mockImplementation((_exec: string, argv: string[]) => cliReply(argv));
  mocks.request.mockImplementation(async (_kind: string, fn: unknown) => {
    const result = state.route?.(getFunctionName(fn as never));
    if (result === undefined) throw new Error("network stopped by the test");
    return result;
  });
  mocks.startOneTimeRedirect.mockImplementation(() => ({
    listening: Promise.reject(new Error("loopback stopped by the test")),
    startUrl: "http://127.0.0.1:4455/start",
    close: async () => {},
  }));
  vi.stubGlobal("fetch", mocks.fetch);
  printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    printed.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every CLI call the run made is a read-only `env get` probe. */
function expectOnlyEnvGetProbes() {
  for (const [, argv] of mocks.spawnSync.mock.calls as [string, string[]][]) {
    expect(argv.slice(1, 3)).toEqual(["env", "get"]);
  }
}

describe("tester entry point: the deployment guard runs first", () => {
  it("covers every command", () => {
    expect(Object.keys(ARGV).sort()).toEqual([...COMMANDS].sort());
  });

  const refusals: [string, () => void, string][] = [
    ["no allowlist file", () => (state.configText = null), "config"],
    [
      "a CLI identity that is production",
      () => (state.identity = `(on prod deployment ${DEV})`),
      "identity",
    ],
    [
      "a CLI identity for another dev deployment",
      () => (state.identity = "(on dev deployment fake-other-303)"),
      "identity",
    ],
    ["no CLI identity label (e.g. self-hosted)", () => (state.identity = ""), "identity"],
    [
      "two CLI identity labels",
      () => (state.identity = `(on dev deployment ${DEV}) (on dev deployment ${DEV})`),
      "identity",
    ],
    ["a missing role marker", () => (state.env.DEPLOYMENT_ROLE = undefined), "role"],
  ];
  const refusalCases = refusals.flatMap(([label, arrange, step]) =>
    COMMANDS.map((command) => [label, command, arrange, step] as const),
  );

  it.each(refusalCases)(
    "with %s, `%s` is refused before any token, client, request or loopback server",
    async (_label, command, arrange, step) => {
      arrange();
      expect(await main(ARGV[command]!)).toBe(1);
      expect(printed.join("")).toContain(`Refused (${step})`);
      for (const mock of sensitive()) expect(mock).not.toHaveBeenCalled();
      if (step === "config") expect(mocks.spawnSync).not.toHaveBeenCalled();
      // A failed identity check stops at the first probe: nothing else is read.
      if (step === "identity") expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
      expectOnlyEnvGetProbes();
    },
  );

  it.each(COMMANDS)(
    "with the guard passing, `%s` acts only after every guard probe",
    async (command) => {
      if (command === "connect") {
        // Let connect reach its loopback server (it then stops: the server cannot listen).
        const callback = encodeURIComponent(`https://${DEV}.convex.site/oauth/callback`);
        state.route = (name) =>
          ({
            "v1/connections:list": [],
            "v1/audit:list": { page: [] },
            "v1/connections:beginConnect": {
              authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${callback}`,
            },
          })[name];
      }
      const code = await main(ARGV[command]!);

      expect(printed[0]).toContain(`Target verified: ${DEV}`);
      expect(mocks.spawnSync).toHaveBeenCalledTimes(6);
      expectOnlyEnvGetProbes();
      const lastProbe = Math.max(...mocks.spawnSync.mock.invocationCallOrder);
      const calls = sensitive().flatMap((mock) => mock.mock.invocationCallOrder);
      if (command === "guard-check") {
        expect(code).toBe(0);
        expect(calls).toEqual([]);
        return;
      }
      expect(code).toBe(1);
      expect(mocks.mintToken).toHaveBeenCalled();
      expect(Math.min(...calls)).toBeGreaterThan(lastProbe);
      // The client URL is derived from the verified deployment name only.
      expect(mocks.clientCreated.mock.calls).toEqual([[`https://${DEV}.convex.cloud`]]);
      expect(mocks.fetch).not.toHaveBeenCalled();
      if (command === "connect") {
        // S2: the claim code returns to the tool's own loopback server, never the dashboard.
        const begin = mocks.request.mock.calls.find(
          ([kind, fn]) =>
            kind === "action" && getFunctionName(fn as never) === "v1/connections:beginConnect",
        );
        expect(begin?.[2]).toEqual({
          provider: "google_ads",
          returnUrl: "http://127.0.0.1:4455/return",
        });
        expect(mocks.startOneTimeRedirect).toHaveBeenCalledTimes(1);
        expect(mocks.startOneTimeRedirect.mock.invocationCallOrder[0]).toBeGreaterThan(lastProbe);
      } else {
        expect(mocks.startOneTimeRedirect).not.toHaveBeenCalled();
      }
    },
  );

  it("connect stops before any token or client unless live mode is enabled", async () => {
    state.env.PROVIDER_MODE = undefined;
    expect(await main(ARGV.connect!)).toBe(1);
    expect(printed.join("")).toContain("PROVIDER_MODE=unset");
    for (const mock of sensitive()) expect(mock).not.toHaveBeenCalled();
  });

  it("the Convex CLI child never inherits deployment-selecting variables", async () => {
    for (const name of CONVEX_SELECTION_ENV_VARS) vi.stubEnv(name, "placeholder");
    expect(await main(ARGV["guard-check"]!)).toBe(0);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(6);
    for (const [, , options] of mocks.spawnSync.mock.calls as [
      string,
      string[],
      { env: Record<string, string> },
    ][]) {
      for (const name of CONVEX_SELECTION_ENV_VARS) expect(options.env).not.toHaveProperty(name);
      expect(options.env.PATH ?? options.env.Path).toBe(process.env.PATH);
    }
    // The tester's own environment is left as it was.
    for (const name of CONVEX_SELECTION_ENV_VARS) expect(process.env[name]).toBe("placeholder");
  });
});
