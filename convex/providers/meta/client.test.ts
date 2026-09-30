import { afterEach, describe, expect, it, vi } from "vitest";
import { appSecretProof, createGraphClient, parseUsageHeaders } from "./client";
import { FAKE_APP_SECRET, graphError, installFakeGraph } from "./fakeGraph.fixtures";

const auth = { accessToken: "test-long-u1", appSecret: FAKE_APP_SECRET };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("appsecret_proof", () => {
  it("is hex HMAC-SHA256(app secret, token) (RFC 4231 test case 2)", async () => {
    expect(await appSecretProof("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("Graph client transport", () => {
  it("GETs with the version prefix, a Bearer token and appsecret_proof, never a token in the URL", async () => {
    const graph = installFakeGraph();
    const client = createGraphClient({ version: "v26.0", timeoutMs: 1_000 });
    const result = await client.get("me", { fields: "id,name" }, auth);
    expect(result.ok).toBe(true);
    expect(graph.log).toHaveLength(1);
    const [entry] = graph.log;
    expect(entry).toMatchObject({ method: "GET", version: "v26.0", path: "me", auth: "user" });
    expect(entry!.hasProof).toBe(true);
    expect(entry!.secretInUrl).toBe(false);
    expect(Object.keys(entry!.params)).not.toContain("access_token");
  });

  it("POSTs OAuth forms without any secret in the URL", async () => {
    const graph = installFakeGraph();
    const client = createGraphClient({ version: "v26.0", timeoutMs: 1_000 });
    await client.postForm("oauth/access_token", {
      client_id: "1234567890",
      client_secret: FAKE_APP_SECRET,
      redirect_uri: "https://x.test/cb",
      code: graph.issueCode("u1"),
    });
    const [entry] = graph.log;
    expect(entry!.method).toBe("POST");
    expect(entry!.params).toEqual({});
    expect(entry!.formFields.sort()).toEqual([
      "client_id",
      "client_secret",
      "code",
      "redirect_uri",
    ]);
    expect(entry!.secretInUrl).toBe(false);
  });

  it("makes exactly one request per call (no retries)", async () => {
    const graph = installFakeGraph();
    graph.inject({ match: () => true, response: graphError(2, undefined, 503) });
    const client = createGraphClient({ version: "v26.0", timeoutMs: 1_000 });
    const result = await client.get("me", {}, auth);
    expect(result.ok).toBe(false);
    expect(graph.calls()).toBe(1);
  });

  it("reports timeouts and network failures without the underlying error", async () => {
    const graph = installFakeGraph();
    graph.inject({ match: () => true, response: "hang" });
    const slow = createGraphClient({ version: "v26.0", timeoutMs: 20 });
    expect(await slow.get("me", {}, auth)).toEqual({ ok: false, failure: { type: "timeout" } });

    graph.inject({ match: () => true, response: "network" });
    const client = createGraphClient({ version: "v26.0", timeoutMs: 1_000 });
    expect(await client.get("me", {}, auth)).toEqual({ ok: false, failure: { type: "network" } });
  });

  it("returns structured Graph errors (code, subcode, usage) and no message text", async () => {
    const graph = installFakeGraph();
    graph.inject({
      match: () => true,
      response: {
        ...graphError(17, 2_446_079),
        headers: {
          "x-business-use-case-usage": JSON.stringify({
            "1001": [{ type: "ads_insights", estimated_time_to_regain_access: 7 }],
          }),
        },
      },
    });
    const client = createGraphClient({ version: "v26.0", timeoutMs: 1_000 });
    const result = await client.get("me", {}, auth);
    expect(result).toEqual({
      ok: false,
      failure: {
        type: "http",
        status: 400,
        error: { code: 17, subcode: 2_446_079 },
        usage: { regainAccessMinutes: 7 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("Fake Graph error");
  });

  it("rejects unsafe paths before any request", async () => {
    const graph = installFakeGraph();
    const client = createGraphClient({ version: "v26.0", timeoutMs: 1_000 });
    await expect(client.get("../evil", {}, auth)).rejects.toThrow("Invalid Graph path");
    await expect(client.get("https://evil.test/x", {}, auth)).rejects.toThrow("Invalid Graph path");
    expect(graph.calls()).toBe(0);
  });
});

describe("usage headers", () => {
  it("parses BUC, ad-account and Retry-After hints; ignores garbage", () => {
    const headers = new Headers({
      "x-business-use-case-usage": JSON.stringify({
        "1": [{ estimated_time_to_regain_access: 3 }, { estimated_time_to_regain_access: 12 }],
        "2": [{ estimated_time_to_regain_access: 5 }],
      }),
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 99, reset_time_duration: 240 }),
      "retry-after": "30",
    });
    expect(parseUsageHeaders(headers)).toEqual({
      regainAccessMinutes: 12,
      accountResetSeconds: 240,
      retryAfterSeconds: 30,
    });
    expect(
      parseUsageHeaders(new Headers({ "x-ad-account-usage": "{not json", "retry-after": "soon" })),
    ).toEqual({});
  });
});
