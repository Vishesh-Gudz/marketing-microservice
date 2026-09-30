/**
 * Parses the `AUTH_ISSUERS` Convex environment variable into Convex
 * `customJwt` providers. One entry per trusted parent application:
 *
 *   [{ "issuer": "https://erp.acme.com",
 *      "jwks": "https://erp.acme.com/.well-known/jwks.json",   // or a data: URI
 *      "applicationID": "marketing-service",
 *      "algorithm": "RS256" }]
 *
 * Unset/empty => no providers => every authenticated call fails (safe default).
 * Malformed => throws, so the deploy fails loudly instead of trusting bad config.
 */
export type IssuerConfig = {
  type: "customJwt";
  issuer: string;
  jwks: string;
  applicationID: string;
  algorithm: "RS256" | "ES256";
};

export function parseAuthIssuers(raw: string | undefined): IssuerConfig[] {
  if (raw === undefined || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AUTH_ISSUERS must be a JSON array of issuer configs.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("AUTH_ISSUERS must be a JSON array of issuer configs.");
  }

  const seen = new Set<string>();
  return parsed.map((entry: unknown, index): IssuerConfig => {
    const where = `AUTH_ISSUERS[${index}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object.`);
    const e = entry as Record<string, unknown>;

    for (const key of ["issuer", "jwks", "applicationID"] as const) {
      if (typeof e[key] !== "string" || (e[key] as string).trim() === "") {
        throw new Error(`${where}.${key} is required (applicationID is mandatory: it pins "aud").`);
      }
    }
    const algorithm = e.algorithm ?? "RS256";
    if (algorithm !== "RS256" && algorithm !== "ES256") {
      throw new Error(`${where}.algorithm must be RS256 or ES256.`);
    }
    const jwks = e.jwks as string;
    if (!jwks.startsWith("https://") && !jwks.startsWith("http://") && !jwks.startsWith("data:")) {
      throw new Error(`${where}.jwks must be an http(s) URL or a data: URI.`);
    }
    const issuer = e.issuer as string;
    if (seen.has(issuer)) throw new Error(`${where}.issuer "${issuer}" is duplicated.`);
    seen.add(issuer);

    return {
      type: "customJwt",
      issuer,
      jwks,
      applicationID: e.applicationID as string,
      algorithm,
    };
  });
}
