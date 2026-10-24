import { vi } from "vitest";
import { appSecretProof } from "../providers/meta/client";
import { WHATSAPP_ENV, WHATSAPP_GRAPH_API_VERSION } from "./config";
import { FAKE_WA_APP_SECRET, stubWhatsAppEnv } from "./fakeWebhook.fixtures";

/**
 * Fake Graph for WhatsApp Embedded Signup (ADR 0014; test harness, two dots in the file name:
 * never deployed). A `fetch`-compatible function serving the onboarding calls exactly as Meta
 * DOCUMENTS them (Embedded Signup "Onboarding customers as a Tech Provider", "Manage accounts",
 * "Phone numbers"; 2026-10-24):
 *
 * - GET oauth/access_token?client_id&client_secret&code -> { access_token } (codes single-use);
 * - GET debug_token?input_token (app token) -> validity, app, scopes and the WABA ids in the
 *   `whatsapp_business_management` granular scope;
 * - GET /{waba}?fields=id,name and GET /{waba}/phone_numbers (cursor paging), business token;
 * - POST /{waba}/subscribed_apps and POST /{phone}/register (JSON body) -> { success: true }.
 *
 * It is NOT evidence of real Meta behavior: error codes are generic (code 100) unless a test
 * injects a documented one, and nothing here is a recording. All ids and secrets are fake.
 * Every call is logged so tests can assert transport rules (where the code, the app secret and
 * the business token may appear). Token-bearing calls are checked like Graph would (Bearer
 * token + appsecret_proof).
 */

export const FAKE_WA_APP_ID = "4440000000001";
export const FAKE_WA_CONFIG_ID = "4440000000002";
export const WHATSAPP_SCOPES_GRANTED = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
];

export type FakeSignup = {
  /** The business token the code exchanges to. */
  token: string;
  /** WABA ids listed in the management granular scope (what the customer shared with us). */
  sharedWabas: string[];
  scopes?: string[];
  /** debug_token app_id (default: ours). */
  appId?: string;
  isValid?: boolean;
  /** debug_token expires_at in seconds (default 0: never). */
  expiresAt?: number;
};

export type FakeWaba = {
  id: string;
  name: string;
  numbers: { id: string; display_phone_number: string }[];
};

export type FakeRoute =
  "exchange" | "debug_token" | "waba" | "phone_numbers" | "subscribe" | "register";

/** An HTTP answer (any status, JSON body), a thrown fetch, a call that never answers, or HTML. */
export type FakeFailure = { status: number; body?: unknown } | "network" | "hang" | "invalid_json";

export type GraphCall = {
  route: FakeRoute | "unknown";
  method: string;
  version: string;
  path: string;
  /** The full request URL (test-only; lets tests assert what never reaches a URL). */
  url: string;
  params: Record<string, string>;
  authorization: string;
  body?: unknown;
};

export type FakeWhatsAppGraph = {
  fetch: typeof fetch;
  log: GraphCall[];
  /** Issues a single-use signup code for `signup`. */
  issueCode(signup: FakeSignup): string;
  addWaba(waba: FakeWaba): void;
  /** The next `times` calls of `route` fail this way (before any other check). */
  failNext(route: FakeRoute, failure: FakeFailure, times?: number): void;
  /** WABAs our app is subscribed to, and the PIN each number was registered with. */
  subscribed: Set<string>;
  registered: Map<string, string>;
  calls(route?: FakeRoute): number;
};

export function graphError(code = 100, status = 400, subcode?: number) {
  return {
    status,
    body: {
      error: {
        message: "Fake Graph error",
        type: "OAuthException",
        code,
        ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      },
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routeOf(method: string, path: string): FakeRoute | "unknown" {
  if (method === "GET" && path === "oauth/access_token") return "exchange";
  if (method === "GET" && path === "debug_token") return "debug_token";
  if (method === "GET" && /^\d+$/.test(path)) return "waba";
  if (method === "GET" && /^\d+\/phone_numbers$/.test(path)) return "phone_numbers";
  if (method === "POST" && /^\d+\/subscribed_apps$/.test(path)) return "subscribe";
  if (method === "POST" && /^\d+\/register$/.test(path)) return "register";
  return "unknown";
}

export function createFakeWhatsAppGraph(): FakeWhatsAppGraph {
  const codes = new Map<string, FakeSignup>();
  const tokens = new Map<string, FakeSignup>();
  const wabas = new Map<string, FakeWaba>();
  const failures: { route: FakeRoute; failure: FakeFailure; times: number }[] = [];
  const subscribed = new Set<string>();
  const registered = new Map<string, string>();
  const log: GraphCall[] = [];
  let codeSeq = 0;

  /** The signup behind a Bearer token with a valid appsecret_proof, or null. */
  async function bearer(call: GraphCall): Promise<FakeSignup | null> {
    const token = call.authorization.replace(/^Bearer /, "");
    const signup = tokens.get(token);
    if (signup === undefined || signup.isValid === false) return null;
    if (call.params.appsecret_proof !== (await appSecretProof(FAKE_WA_APP_SECRET, token))) {
      return null;
    }
    return signup;
  }

  function sharedWaba(signup: FakeSignup, wabaId: string): FakeWaba | undefined {
    return signup.sharedWabas.includes(wabaId) ? wabas.get(wabaId) : undefined;
  }

  async function route(call: GraphCall): Promise<Response> {
    switch (call.route) {
      case "exchange": {
        const { client_id, client_secret, code } = call.params;
        if (client_id !== FAKE_WA_APP_ID || client_secret !== FAKE_WA_APP_SECRET) {
          return json(400, graphError(101).body);
        }
        const signup = code === undefined ? undefined : codes.get(code);
        if (signup === undefined) return json(400, graphError(100).body);
        codes.delete(code!); // single use
        tokens.set(signup.token, signup);
        return json(200, { access_token: signup.token, token_type: "bearer" });
      }
      case "debug_token": {
        if (call.authorization !== `Bearer ${FAKE_WA_APP_ID}|${FAKE_WA_APP_SECRET}`) {
          return json(400, graphError(190).body);
        }
        const signup = tokens.get(call.params.input_token ?? "");
        if (signup === undefined) {
          return json(200, { data: { app_id: FAKE_WA_APP_ID, is_valid: false } });
        }
        const scopes = signup.scopes ?? WHATSAPP_SCOPES_GRANTED;
        return json(200, {
          data: {
            app_id: signup.appId ?? FAKE_WA_APP_ID,
            type: "SYSTEM_USER",
            application: "Fake WhatsApp App",
            is_valid: signup.isValid ?? true,
            expires_at: signup.expiresAt ?? 0,
            scopes,
            granular_scopes: scopes.map((scope) => ({ scope, target_ids: signup.sharedWabas })),
          },
        });
      }
      case "waba": {
        const signup = await bearer(call);
        const waba = signup === null ? undefined : sharedWaba(signup, call.path);
        if (waba === undefined) return json(400, graphError(100, 400, 33).body);
        return json(200, { id: waba.id, name: waba.name });
      }
      case "phone_numbers": {
        const signup = await bearer(call);
        const waba = signup === null ? undefined : sharedWaba(signup, call.path.split("/")[0]!);
        if (waba === undefined) return json(400, graphError(100, 400, 33).body);
        const limit = Number(call.params.limit ?? "25");
        const offset = call.params.after === undefined ? 0 : Number(atob(call.params.after));
        const page = waba.numbers.slice(offset, offset + limit);
        const more = offset + limit < waba.numbers.length;
        return json(200, {
          data: page.map((n) => ({ ...n, verified_name: waba.name })),
          paging: {
            cursors: { before: btoa(String(offset)), after: btoa(String(offset + page.length)) },
            ...(more ? { next: "https://graph.facebook.com/next-page" } : {}),
          },
        });
      }
      case "subscribe": {
        const signup = await bearer(call);
        const wabaId = call.path.split("/")[0]!;
        if (signup === null || sharedWaba(signup, wabaId) === undefined) {
          return json(400, graphError(100, 400, 33).body);
        }
        subscribed.add(wabaId);
        return json(200, { success: true });
      }
      case "register": {
        const signup = await bearer(call);
        const phoneId = call.path.split("/")[0]!;
        const owned =
          signup !== null &&
          signup.sharedWabas.some((id) => wabas.get(id)?.numbers.some((n) => n.id === phoneId));
        const body = call.body as { messaging_product?: unknown; pin?: unknown } | undefined;
        if (!owned) return json(400, graphError(100, 400, 33).body);
        if (body?.messaging_product !== "whatsapp" || typeof body.pin !== "string") {
          return json(400, graphError(100).body);
        }
        if (!/^\d{6}$/.test(body.pin)) return json(400, graphError(100).body);
        registered.set(phoneId, body.pin);
        return json(200, { success: true });
      }
      default:
        return json(404, graphError(2500, 404).body);
    }
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const versionMatch = /^\/(v\d+\.0)\/(.*)$/.exec(url.pathname);
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    const path = versionMatch?.[2] ?? url.pathname;
    const text = request.method === "POST" ? await request.clone().text() : "";
    const call: GraphCall = {
      route: routeOf(request.method, path),
      method: request.method,
      version: versionMatch?.[1] ?? "none",
      path,
      url: request.url,
      params,
      authorization: request.headers.get("authorization") ?? "",
      ...(text !== "" ? { body: JSON.parse(text) as unknown } : {}),
    };
    log.push(call);

    const rule = failures.find((f) => f.route === call.route && f.times > 0);
    if (rule !== undefined) {
      rule.times -= 1;
      const failure = rule.failure;
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "hang") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      if (failure === "invalid_json") return new Response("<html>", { status: 200 });
      return json(failure.status, failure.body ?? {});
    }
    if (
      url.origin !== "https://graph.facebook.com" ||
      call.version !== WHATSAPP_GRAPH_API_VERSION
    ) {
      return json(404, graphError(2500, 404).body);
    }
    return await route(call);
  };

  return {
    fetch: fakeFetch as typeof fetch,
    log,
    issueCode(signup) {
      codeSeq += 1;
      const code = `AQ-test-signup-code-${codeSeq}`;
      codes.set(code, signup);
      return code;
    },
    addWaba(waba) {
      wabas.set(waba.id, waba);
    },
    failNext(route, failure, times = 1) {
      failures.push({ route, failure, times });
    },
    subscribed,
    registered,
    calls: (route) =>
      route === undefined ? log.length : log.filter((c) => c.route === route).length,
  };
}

/** Test-only Meta app values for Embedded Signup, plus `fetch` served by the fake Graph. */
export function installFakeWhatsAppGraph(
  graph: FakeWhatsAppGraph = createFakeWhatsAppGraph(),
): FakeWhatsAppGraph {
  stubWhatsAppEnv();
  vi.stubEnv(WHATSAPP_ENV.appId, FAKE_WA_APP_ID);
  vi.stubEnv(WHATSAPP_ENV.signupConfigId, FAKE_WA_CONFIG_ID);
  vi.stubGlobal("fetch", graph.fetch);
  return graph;
}
