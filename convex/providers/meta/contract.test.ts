import { afterAll, beforeAll, vi } from "vitest";
import { runAdsProviderContract } from "../contract.suite";
import { runOAuthSpecContract } from "../oauth.suite";
import { createMetaAdsProvider } from ".";
import type { MetaCredential } from "./credential";
import {
  createFakeGraph,
  FAKE_APP_CONFIG,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_RANGE,
  installFakeGraph,
} from "./fakeGraph.fixtures";
import { createMetaOAuthSpec } from "./oauth";

// Phase 8 Stage B: the shared contracts run against the PRODUCTION Meta provider (engine +
// META_MAPPING) and the fake Graph's Marketing-API-shaped fixtures. They prove the contract
// (referential integrity, capabilities, staged paging, cursors, page-size invariance); the
// Meta semantics they exercise are the provisional ones (docs/providers/meta.md).

const graph = createFakeGraph();
beforeAll(() => {
  installFakeGraph(graph);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const credential: MetaCredential = {
  kind: "meta",
  v: 1,
  accessToken: "test-long-u1",
  tokenType: "user",
  appId: FAKE_APP_ID,
  issuedAt: 1_790_000_000_000,
};

runAdsProviderContract({
  name: "meta (fake Graph, production mapping)",
  create: () =>
    createMetaAdsProvider({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
    }),
  credential,
  range: FAKE_RANGE,
});

runOAuthSpecContract({
  name: "meta FLfB (fake Graph)",
  create: () => createMetaOAuthSpec(),
  config: FAKE_APP_CONFIG,
  validCode: () => graph.issueCode("u1"),
  invalidCode: "test-code-invalid",
});
