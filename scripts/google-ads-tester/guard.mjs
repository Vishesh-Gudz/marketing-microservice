// Deployment guard for the Google Ads tester (DEV / VALIDATION TOOLING ONLY). FAILS CLOSED.
//
// The tester may only act on ONE explicitly allowlisted Convex validation deployment:
//   1. local allowlist: `.google-ads-tester.local.json` (git-ignored) names it, and the
//      `--deployment` argument must equal it (no URLs, no `local` / `prod` / `dev` refs);
//   2. identity from the trusted Convex CLI (the operator's own login): an `env get` probe of
//      a name that does not exist reports "(on <type> deployment <name>)" without printing
//      any value; the type must be `dev` and the name must match;
//   3. the project's production deployment (same probe with `--prod`) must be a DIFFERENT
//      deployment, and must be resolvable (otherwise refuse);
//   4. role marker: DEPLOYMENT_ROLE must equal "google-ads-validation" on the target;
//   5. configuration: AUTH_ISSUERS must trust the dev issuer and GOOGLE_CLIENT_ID must be a
//      Google web client id. PROVIDER_MODE is reported, never changed.
// Values read by the guard are compared in memory and never printed. The client secret is
// never read. Convex URLs are derived from the verified name only.

export const CONFIG_FILE = ".google-ads-tester.local.json";
export const VALIDATION_ROLE = "google-ads-validation";
export const IDENTITY_PROBE = "GADS_TESTER_IDENTITY_PROBE";

const DEPLOYMENT_NAME = /^[a-z]+-[a-z]+-\d{1,6}$/;
const ORG = /^[A-Za-z0-9_-]{1,64}$/;
const GOOGLE_CLIENT_ID = /^\d{1,32}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/;
const IDENTITY = /\(on (dev|prod|preview|local) deployment ([a-z0-9-]+)\)/g;

export class GuardError extends Error {
  constructor(step, message) {
    super(message);
    this.name = "GuardError";
    this.step = step;
  }
}

/** Parses and validates the local allowlist file. */
export function parseConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GuardError("config", `${CONFIG_FILE} is not valid JSON.`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GuardError("config", `${CONFIG_FILE} must be a JSON object.`);
  }
  const { validationDeployment, org = "gads-validation" } = raw;
  if (typeof validationDeployment !== "string" || !DEPLOYMENT_NAME.test(validationDeployment)) {
    throw new GuardError(
      "config",
      `${CONFIG_FILE}: "validationDeployment" must be a Convex deployment name (e.g. happy-otter-123).`,
    );
  }
  if (typeof org !== "string" || !ORG.test(org)) {
    throw new GuardError("config", `${CONFIG_FILE}: "org" must match ${ORG}.`);
  }
  return { validationDeployment, org };
}

/** The single "(on <type> deployment <name>)" label of a CLI output, or null. */
export function parseIdentity(output) {
  const matches = [...String(output).matchAll(IDENTITY)];
  if (matches.length !== 1) return null;
  return { type: matches[0][1], name: matches[0][2] };
}

function combined(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

/** The value printed by a successful `env get`, or undefined when not found / failed. */
function envValue(result) {
  if (!result || result.status !== 0) return undefined;
  if (/not found/i.test(combined(result))) return undefined;
  const value = String(result.stdout ?? "").replace(/\r?\n$/, "");
  return value === "" ? undefined : value;
}

/**
 * Verifies the requested deployment. `runConvex(args)` runs the Convex CLI and returns
 * `{ status, stdout, stderr }` (injectable for tests). Throws GuardError on any doubt.
 */
export function verifyDeployment({ requested, config, runConvex }) {
  if (typeof requested !== "string" || requested === "") {
    throw new GuardError(
      "argument",
      "Pass --deployment <name> (the allowlisted validation deployment).",
    );
  }
  if (/[:/.]/.test(requested) || ["local", "prod", "dev", "production"].includes(requested)) {
    throw new GuardError("argument", "Only a concrete validation deployment name is accepted.");
  }
  if (!DEPLOYMENT_NAME.test(requested)) {
    throw new GuardError("argument", "Not a Convex deployment name.");
  }
  if (requested !== config.validationDeployment) {
    throw new GuardError(
      "allowlist",
      `The deployment is not the one allowlisted in ${CONFIG_FILE}.`,
    );
  }

  const target = parseIdentity(
    combined(runConvex(["env", "get", IDENTITY_PROBE, "--deployment", requested])),
  );
  if (target === null) {
    throw new GuardError(
      "identity",
      "Could not establish the deployment identity via the Convex CLI.",
    );
  }
  if (target.type !== "dev" || target.name !== requested) {
    throw new GuardError(
      "identity",
      `Refusing: the Convex CLI reports a "${target.type}" deployment, not the allowlisted dev deployment.`,
    );
  }

  const prod = parseIdentity(combined(runConvex(["env", "get", IDENTITY_PROBE, "--prod"])));
  if (prod === null || prod.type !== "prod") {
    throw new GuardError(
      "production",
      "Could not resolve the project's production deployment; refusing.",
    );
  }
  if (prod.name === requested) {
    throw new GuardError("production", "Refusing: the target is the production deployment.");
  }

  if (
    envValue(runConvex(["env", "get", "DEPLOYMENT_ROLE", "--deployment", requested])) !==
    VALIDATION_ROLE
  ) {
    throw new GuardError(
      "role",
      `Refusing: DEPLOYMENT_ROLE is not "${VALIDATION_ROLE}" on the target deployment.`,
    );
  }

  const issuers = envValue(runConvex(["env", "get", "AUTH_ISSUERS", "--deployment", requested]));
  let trustsDevIssuer = false;
  try {
    const parsed = JSON.parse(issuers ?? "[]");
    trustsDevIssuer =
      Array.isArray(parsed) &&
      parsed.some((p) => p && p.issuer === "https://dev-issuer.marketing.local");
  } catch {
    trustsDevIssuer = false;
  }
  if (!trustsDevIssuer) {
    throw new GuardError("config", "The target does not trust the dev issuer (AUTH_ISSUERS).");
  }

  const clientId = envValue(
    runConvex(["env", "get", "GOOGLE_CLIENT_ID", "--deployment", requested]),
  );
  if (clientId === undefined || !GOOGLE_CLIENT_ID.test(clientId)) {
    throw new GuardError("config", "GOOGLE_CLIENT_ID is missing or not a Google web client id.");
  }

  const mode = envValue(runConvex(["env", "get", "PROVIDER_MODE", "--deployment", requested]));
  return {
    deployment: requested,
    cloudUrl: `https://${requested}.convex.cloud`,
    siteUrl: `https://${requested}.convex.site`,
    providerMode: mode === "live" || mode === "mock" ? mode : "unset",
    productionDeployment: prod.name,
    org: config.org,
  };
}
