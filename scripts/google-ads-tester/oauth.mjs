// One-time loopback redirect for Google consent (DEV / VALIDATION TOOLING ONLY).
// The authorization URL (state, PKCE challenge, client id) is never printed: the operator
// opens http://127.0.0.1:<port>/start, which answers ONE redirect and then closes.
// Requests must carry the exact loopback Host (no DNS rebinding); anything else is refused.

import { createServer } from "node:http";

export function startOneTimeRedirect(authorizeUrl, { port = 4455 } = {}) {
  let served = false;
  const host = `127.0.0.1:${port}`;
  const server = createServer((req, res) => {
    if (req.headers.host !== host) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end("Misdirected request");
      return;
    }
    if (req.method === "GET" && req.url === "/start" && !served) {
      served = true;
      res.writeHead(302, {
        Location: authorizeUrl,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      setImmediate(() => server.close());
      return;
    }
    res.writeHead(410, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Gone");
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    startUrl: `http://${host}/start`,
    listening,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get served() {
      return served;
    },
  };
}
