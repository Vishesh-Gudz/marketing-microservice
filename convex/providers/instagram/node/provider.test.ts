import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderError } from "../../errors";
import { INSTAGRAM_CAPABILITIES } from "../capabilities";
import { FAKE_IG_APP_ID } from "../fakeInstagram.fixtures";
import { INSTAGRAM_MAPPING_PENDING } from "../mapping";
import { createInstagramSocialProvider } from "./provider";

// Stage A: every Instagram sync operation fails CLOSED before any network access.

const USER_ID = "17841400000000101";
const credential = {
  kind: "instagram",
  v: 1,
  accessToken: "IGAAfakelong1",
  tokenType: "long_lived",
  appId: FAKE_IG_APP_ID,
  userId: USER_ID,
  issuedAt: 0,
};

afterEach(() => vi.unstubAllGlobals());

const provider = createInstagramSocialProvider({ appId: FAKE_IG_APP_ID });
const calls = [
  [
    "getSocialAccount",
    () => provider.getAccount({ credential, attempt: 1 }, { accountExternalId: USER_ID }),
  ],
  [
    "listSocialPosts",
    () => provider.listPosts({ credential, attempt: 1 }, { accountExternalId: USER_ID }),
  ],
  [
    "fetchPostMetrics",
    () =>
      provider.fetchPostMetrics(
        { credential, attempt: 1 },
        { accountExternalId: USER_ID, publishedFrom: "2026-07-01" },
      ),
  ],
  [
    "fetchAccountMetrics",
    () =>
      provider.fetchAccountMetrics(
        { credential, attempt: 1 },
        { accountExternalId: USER_ID, from: "2026-09-01", to: "2026-09-02" },
      ),
  ],
] as const;

async function error(run: () => Promise<unknown>) {
  const caught = await run().catch((e: unknown) => e);
  if (!isProviderError(caught)) throw new Error("expected ProviderError");
  return caught;
}

describe("Instagram SocialProvider (Stage A)", () => {
  it("declares nothing it does not implement", () => {
    expect(provider.platform).toBe("instagram");
    expect(provider.capabilities).toBe(INSTAGRAM_CAPABILITIES);
    expect(provider.capabilities.posts).toBe(false);
    expect(provider.capabilities.postMetrics).toEqual([]);
    expect(provider.capabilities.accountMetrics).toEqual([]);
  });

  it.each(calls)(
    "%s fails closed with instagram_mapping_pending, never 'unsupported'",
    async (operation, run) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const failure = await error(run);
      expect(failure).toMatchObject({
        kind: "unknown",
        platform: "instagram",
        operation,
        providerCode: INSTAGRAM_MAPPING_PENDING,
        retryable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("checks configuration, credential and account ownership first", async () => {
    const unconfigured = createInstagramSocialProvider({});
    expect(
      (
        await error(() =>
          unconfigured.getAccount({ credential, attempt: 1 }, { accountExternalId: USER_ID }),
        )
      ).providerCode,
    ).toBe("instagram_config_invalid");
    const ads = await error(() =>
      provider.getAccount(
        { credential: { kind: "meta" }, attempt: 1 },
        { accountExternalId: USER_ID },
      ),
    );
    expect([ads.kind, ads.providerCode]).toEqual(["auth", "credential_invalid"]);
    const foreignApp = createInstagramSocialProvider({ appId: "1790000000000999" });
    const app = await error(() =>
      foreignApp.getAccount({ credential, attempt: 1 }, { accountExternalId: USER_ID }),
    );
    expect([app.kind, app.providerCode]).toEqual(["auth", "app_id_mismatch"]);
    const other = await error(() =>
      provider.listPosts({ credential, attempt: 1 }, { accountExternalId: "17841400000000999" }),
    );
    expect([other.kind, other.providerCode]).toEqual(["permission", "account_mismatch"]);
    const bad = await error(() =>
      provider.listPosts({ credential, attempt: 1 }, { accountExternalId: "act_1" }),
    );
    expect([bad.kind, bad.providerCode]).toEqual(["invalid_request", "account_invalid"]);
  });
});
