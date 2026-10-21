import { afterAll, beforeAll, vi } from "vitest";
import { runAdsProviderContract } from "../contract.suite";
import { runOAuthSpecContract } from "../oauth.suite";
import { createGoogleAdsProvider } from ".";
import type { GoogleCredential } from "./credential";
import {
  createFakeGoogleAds,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_CONFIG,
  FAKE_GOOGLE_RANGE,
  fakeGoogleDataset,
  installFakeGoogleAds,
} from "./fakeGoogleAds.fixtures";
import { createGoogleOAuthSpec } from "./oauth";

// Phase 9: the shared contracts run against the Google provider with its PRODUCTION mapping
// and the fake Google Ads API (documented API shapes; not real-account evidence).

// The contract lists every non-manager account; the cancelled client cannot be queried, so
// this run uses the dataset without it (cancelled accounts are covered in provider.test.ts).
const fake = createFakeGoogleAds({ dataset: fakeGoogleDataset({ cancelled: false }) });
beforeAll(() => {
  installFakeGoogleAds(fake);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const credential: GoogleCredential = {
  kind: "google",
  v: 1,
  refreshToken: "test-refresh-u1",
  clientId: FAKE_GOOGLE_CLIENT_ID,
  issuedAt: 1,
  scopes: ["https://www.googleapis.com/auth/adwords", "openid"],
};

// The refresh token must exist in the fake: mint one through a real code exchange first.
beforeAll(async () => {
  const verifier = "contract-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await createGoogleOAuthSpec().exchangeCode({
    code: fake.issueCode("u1", challenge),
    redirectUri: "https://marketing-tests.convex.site/oauth/callback",
    codeVerifier: verifier,
    config: FAKE_GOOGLE_CONFIG,
    now: 1,
  });
});

runAdsProviderContract({
  name: "google provider (fake API)",
  create: () =>
    createGoogleAdsProvider({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    }),
  credential,
  range: FAKE_GOOGLE_RANGE,
});

runOAuthSpecContract({
  name: "google OAuth (fake API)",
  create: () => createGoogleOAuthSpec(),
  config: FAKE_GOOGLE_CONFIG,
  validCode: (_url, challenge) => fake.issueCode("u1", challenge!),
  invalidCode: "test-gcode-invalid",
});
