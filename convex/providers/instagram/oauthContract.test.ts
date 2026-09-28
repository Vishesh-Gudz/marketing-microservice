import { afterEach, beforeEach, vi } from "vitest";
import { runOAuthSpecContract } from "../oauth.suite";
import { createMockInstagramOAuthSpec, MOCK_IG_INVALID_CODE } from "../social/mock";
import {
  createFakeInstagram,
  FAKE_IG_APP_ID,
  FAKE_IG_APP_SECRET,
  type FakeInstagram,
} from "./fakeInstagram.fixtures";
import { createInstagramOAuthSpec } from "./oauth";

// The Phase 4 OAuthSpec contract, run against the real Instagram spec (fake API) and the
// mock-mode Instagram spec.

let fake: FakeInstagram = createFakeInstagram();
beforeEach(() => {
  fake = createFakeInstagram();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

runOAuthSpecContract({
  name: "instagram (fake API)",
  create: () => createInstagramOAuthSpec(),
  config: { clientId: FAKE_IG_APP_ID, clientSecret: FAKE_IG_APP_SECRET },
  validCode: () => fake.issueCode("business"),
  invalidCode: "igcodefake-never-issued",
});

runOAuthSpecContract({
  name: "mock instagram",
  create: () => createMockInstagramOAuthSpec(),
  config: {},
  validCode: (url) => new URL(url).searchParams.get("code")!,
  invalidCode: MOCK_IG_INVALID_CODE,
});
