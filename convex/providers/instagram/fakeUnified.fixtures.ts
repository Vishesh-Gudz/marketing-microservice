/// <reference types="vite/client" />
/**
 * TEST-ONLY fake of the Instagram API with Unified Login endpoints (config.ts; two dots in the
 * filename: never deployed). It models DOCUMENTED shapes only and is NOT evidence of real Meta
 * behavior; the send endpoint in particular is undocumented for Unified Login [assume].
 *
 *   GET  https://graph.facebook.com/v26.0/oauth/access_token          code -> system-user token
 *   GET  https://graph.facebook.com/v26.0/debug_token                 validity, app, permissions
 *   GET  https://graph.facebook.com/v26.0/me/assigned_instagram_accounts?fields=id,username
 *   POST https://graph.facebook.com/v26.0/{ig-id}/subscribed_apps     webhook subscription
 *   POST https://graph.facebook.com/v26.0/{ig-id}/messages            a text reply
 *
 * Every request is logged (method, path, parameter NAMES, Bearer or not, the full URL) so tests
 * can check the exact calls and scan for leaks. All ids, tokens and secrets are fake.
 */
export const FAKE_UNIFIED_APP_ID = "2262000000000001";
export const FAKE_UNIFIED_APP_SECRET = "fake-unified-app-secret-DO-NOT-USE";
export const FAKE_UNIFIED_CONFIG_ID = "2144000000000001";
/** Every fake system-user token starts with this marker (leak scans search for it). */
export const FAKE_UNIFIED_TOKEN_MARKER = "EAAGunifiedfake";
/** Every fake authorization code starts with this marker. */
export const FAKE_UNIFIED_CODE_MARKER = "ulcodefake";

export type FakeUnifiedClient = {
  /** The Instagram accounts the client assigned to the app. */
  accounts: { id: string; username?: string }[];
  /** The permissions debug_token reports. */
  scopes: string[];
  /** debug_token's is_valid (default true). */
  valid?: boolean;
  /** debug_token's app_id (default: the fake app id). */
  appId?: string;
};

export type FakeUnifiedRoute =
  "code_exchange" | "debug_token" | "accounts" | "subscribed_apps" | "send_message";

export type FakeUnifiedRequest = {
  method: string;
  path: string;
  params: string[];
  bearer: boolean;
  url: string;
};

const DEFAULT_CLIENTS: Record<string, FakeUnifiedClient> = {
  messaging: {
    accounts: [{ id: "17841400000000301", username: "fake_unified" }],
    scopes: ["instagram_basic", "instagram_manage_messages"],
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const graphError = (status: number, code: number, subcode?: number) =>
  json(status, {
    error: {
      message: "fake",
      type: "OAuthException",
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
    },
  });

export function createFakeUnified(
  options: {
    clients?: Record<string, FakeUnifiedClient>;
    failures?: Partial<
      Record<FakeUnifiedRoute, { status: number; code: number; subcode?: number }>
    >;
  } = {},
) {
  const clients: Record<string, FakeUnifiedClient> = { ...DEFAULT_CLIENTS, ...options.clients };
  const failures = { ...options.failures };
  const requests: FakeUnifiedRequest[] = [];
  const codes = new Map<string, string>(); // code -> client
  const tokens = new Map<string, string>(); // token -> client
  const subscriptions: { account: string; fields: string }[] = [];
  const sent: { account: string; recipient: string; text: string; mid: string }[] = [];
  let counter = 0;

  function clientOfBearer(request: Request): FakeUnifiedClient | undefined {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const name = tokens.get(token);
    return name === undefined ? undefined : clients[name];
  }

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input instanceof URL ? input.toString() : input, init);
    const url = new URL(request.url);
    const names: string[] = [];
    url.searchParams.forEach((_value, name) => names.push(name));
    requests.push({
      method: request.method,
      path: url.pathname,
      params: names.sort(),
      bearer: (request.headers.get("authorization") ?? "").startsWith("Bearer "),
      url: url.toString(),
    });
    if (url.hostname !== "graph.facebook.com") return graphError(404, 803);
    const path = url.pathname;
    const q = url.searchParams;

    if (request.method === "GET" && path === "/v26.0/oauth/access_token") {
      if (failures.code_exchange) {
        const f = failures.code_exchange;
        return graphError(f.status, f.code, f.subcode);
      }
      const client = codes.get(q.get("code") ?? "");
      if (
        client === undefined ||
        q.get("client_id") !== FAKE_UNIFIED_APP_ID ||
        q.get("client_secret") !== FAKE_UNIFIED_APP_SECRET
      ) {
        return graphError(400, 100, 36007);
      }
      codes.delete(q.get("code")!); // single use
      const token = `${FAKE_UNIFIED_TOKEN_MARKER}-${client}-${++counter}`;
      tokens.set(token, client);
      return json(200, { access_token: token, token_type: "bearer" });
    }
    if (request.method === "GET" && path === "/v26.0/debug_token") {
      if (failures.debug_token) {
        const f = failures.debug_token;
        return graphError(f.status, f.code, f.subcode);
      }
      if (q.get("access_token") !== `${FAKE_UNIFIED_APP_ID}|${FAKE_UNIFIED_APP_SECRET}`) {
        return graphError(400, 190);
      }
      const name = tokens.get(q.get("input_token") ?? "");
      const client = name === undefined ? undefined : clients[name];
      if (client === undefined) return json(200, { data: { is_valid: false } });
      return json(200, {
        data: {
          app_id: client.appId ?? FAKE_UNIFIED_APP_ID,
          type: "SYSTEM_USER",
          is_valid: client.valid ?? true,
          expires_at: 0,
          scopes: client.scopes,
        },
      });
    }
    if (request.method === "GET" && path === "/v26.0/me/assigned_instagram_accounts") {
      if (failures.accounts) {
        const f = failures.accounts;
        return graphError(f.status, f.code, f.subcode);
      }
      const client = clientOfBearer(request);
      if (client === undefined) return graphError(400, 190);
      return json(200, { data: client.accounts });
    }
    const subscribe = /^\/v26\.0\/(\d+)\/subscribed_apps$/.exec(path);
    if (request.method === "POST" && subscribe) {
      if (failures.subscribed_apps) {
        const f = failures.subscribed_apps;
        return graphError(f.status, f.code, f.subcode);
      }
      const client = clientOfBearer(request);
      if (client === undefined || !client.accounts.some((a) => a.id === subscribe[1])) {
        return graphError(400, 190);
      }
      subscriptions.push({ account: subscribe[1]!, fields: q.get("subscribed_fields") ?? "" });
      return json(200, { success: true });
    }
    const message = /^\/v26\.0\/(\d+)\/messages$/.exec(path);
    if (request.method === "POST" && message) {
      if (failures.send_message) {
        const f = failures.send_message;
        return graphError(f.status, f.code, f.subcode);
      }
      const client = clientOfBearer(request);
      if (client === undefined || !client.accounts.some((a) => a.id === message[1])) {
        return graphError(400, 190);
      }
      const body = (await request.json()) as {
        recipient?: { id?: string };
        message?: { text?: string };
      };
      const mid = `m_unified_${++counter}`;
      sent.push({
        account: message[1]!,
        recipient: body.recipient?.id ?? "",
        text: body.message?.text ?? "",
        mid,
      });
      return json(200, { recipient_id: body.recipient?.id, message_id: mid });
    }
    return graphError(404, 803);
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    clients,
    requests,
    subscriptions,
    sent,
    failures,
    /** An authorization code the dialog would hand back for `client`. */
    issueCode(client = "messaging"): string {
      const code = `${FAKE_UNIFIED_CODE_MARKER}-${client}-${++counter}`;
      codes.set(code, client);
      return code;
    },
    reset() {
      requests.length = 0;
    },
  };
}

export type FakeUnified = ReturnType<typeof createFakeUnified>;
