import { runAdsProviderContract } from "./contract.suite";
import { createMockAdsProvider, mockCredential } from "./mock";

// Both mock flavors must pass the same contract the real providers will.
runAdsProviderContract({
  name: "mock meta",
  create: () => createMockAdsProvider({ platform: "meta" }),
  credential: mockCredential(),
  range: { from: "2026-03-01", to: "2026-03-14" },
});

runAdsProviderContract({
  name: "mock google_ads",
  create: () => createMockAdsProvider({ platform: "google_ads" }),
  credential: mockCredential(),
  range: { from: "2026-03-01", to: "2026-03-14" },
});
