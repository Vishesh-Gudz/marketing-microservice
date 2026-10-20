// Output redaction for the Google Ads tester (DEV / VALIDATION TOOLING ONLY).
// Every line the tester prints passes through `redact`: JWTs, bearer tokens, OAuth URLs and
// OAuth/credential query parameters, Google token shapes, deploy keys, private keys and
// email addresses never reach the terminal. The tester never prints these on purpose; this
// is the safety net.

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<redacted-jwt>"],
  [/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>"],
  [
    /https?:\/\/(?:accounts\.google\.com|oauth2\.googleapis\.com)[^\s"']*/gi,
    "<redacted-oauth-url>",
  ],
  [
    /([?&#](?:state|code|code_challenge|code_verifier|access_token|refresh_token|id_token|client_secret|client_id|token)=)[^&\s"']*/gi,
    "$1<redacted>",
  ],
  [/\bGOCSPX-[A-Za-z0-9_-]+/g, "<redacted-secret>"],
  [/\bya29\.[A-Za-z0-9._-]+/g, "<redacted-token>"],
  [/\b1\/\/[A-Za-z0-9_-]{10,}/g, "<redacted-token>"],
  [/\b(?:dev|prod|preview):[a-z0-9-]+\|[A-Za-z0-9+/=_-]+/g, "<redacted-deploy-key>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>"],
];

/** Returns `text` with every secret-shaped substring replaced. */
export function redact(text) {
  let out = String(text);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A line writer whose every line is redacted (`write` is injectable for tests). */
export function createOutput(write = (chunk) => process.stdout.write(chunk)) {
  return {
    line(...parts) {
      write(`${redact(parts.join(" "))}\n`);
    },
  };
}
