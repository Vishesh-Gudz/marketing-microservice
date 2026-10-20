import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderContext } from "../types";
import { createGoogleAdsProvider, type GoogleCredential } from ".";
import {
  createFakeGoogleAds,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_RANGE,
  fakeGoogleCredential,
  installFakeGoogleAds,
} from "./fakeGoogleAds.fixtures";

// The mapping seam fails CLOSED: an operation without a mapping entry is "unknown" /
// google_mapping_pending before any network call — never "unsupported" (which would skip
// the task and could advance coverage over missing data). Proven with an EMPTY mapping
// module (the production mapping is complete since Stage B).
vi.mock("./mapping", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GOOGLE_MAPPING: Object.freeze({}),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const METRICS = {
  accountExternalId: "2220000001",
  level: "campaign" as const,
  breakdown: "none" as const,
  ...FAKE_GOOGLE_RANGE,
};

describe("mapping seam without entries", () => {
  it.each([
    "listCampaigns",
    "listAdGroups",
    "listAds",
    "listCreatives",
    "fetchDailyMetrics",
    "fetchActionMetrics",
  ] as const)("%s → unknown google_mapping_pending, no network", async (operation) => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    const ctx: ProviderContext<GoogleCredential> = {
      credential: fakeGoogleCredential(fake.grantRefreshToken("u1")),
      attempt: 1,
    };
    const provider = createGoogleAdsProvider({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    });
    const call =
      operation === "fetchDailyMetrics" || operation === "fetchActionMetrics"
        ? provider[operation](ctx, METRICS)
        : provider[operation](ctx, { accountExternalId: "2220000001" });
    await expect(call).rejects.toMatchObject({
      kind: "unknown",
      providerCode: "google_mapping_pending",
      retryable: false,
    });
    expect(fake.log).toHaveLength(0);
  });
});
