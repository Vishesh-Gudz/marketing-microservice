// One-time loopback redirect for Google consent (DEV / VALIDATION TOOLING ONLY).
// The authorization URL (state, PKCE challenge, client id) is never printed: the operator
// opens http://127.0.0.1:<port>/start, which answers ONE redirect. The OAuth callback then
// returns the browser ONCE to http://127.0.0.1:<port>/return with the result (S2: a one-time
// claim code the tool redeems as the same identity); the server then closes. Requests must
// carry the exact loopback Host (no DNS rebinding); anything else is refused.

import { createServer } from "node:http";

export const DEFAULT_PORT = 4455;
const RETURN_PATH = "/return";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * The OAuth return URL for `port`. Its origin must be allowlisted for the dev integration app
 * on the validation deployment (an operator step outside the tool).
 */
export function loopbackReturnUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}${RETURN_PATH}`;
}

/**
 * Serves `/start` once (redirect to `authorizeUrl`), then `/return` once. `result` resolves
 * with the callback's result parameters (`status`, `claim`, `error`; nothing else is read).
 * The returned page shows fixed text only and never echoes a parameter.
 */
export function startOneTimeRedirect(authorizeUrl, { port = DEFAULT_PORT } = {}) {
  let served = false;
  let returned = false;
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const host = `127.0.0.1:${port}`;
  const server = createServer((req, res) => {
    if (req.headers.host !== host) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end("Misdirected request");
      return;
    }
    if (req.method === "GET" && req.url === "/start" && !served) {
      served = true;
      res.writeHead(302, { Location: authorizeUrl, ...NO_STORE });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === RETURN_PATH && served && !returned) {
      returned = true;
      const pick = (name) => url.searchParams.get(name) ?? undefined;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'",
        ...NO_STORE,
      });
      res.end("Sign-in finished. Return to the terminal.");
      resolveResult({ status: pick("status"), claim: pick("claim"), error: pick("error") });
      setImmediate(() => server.close());
      return;
    }
    res.writeHead(410, { "Content-Type": "text/plain", ...NO_STORE });
    res.end("Gone");
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    startUrl: `http://${host}/start`,
    listening,
    result,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get served() {
      return served;
    },
  };
}
