// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CALLBACK_ERROR_CODES } from "@/convex/connections/oauthState";
import { SYNC_ERROR_REASONS } from "@/convex/sync/publicStatus";
import { CALLBACK_ERRORS } from "@/lib/connections/connect-result";
import { ERROR_REASON_MESSAGES, META_ERROR_REASON_MESSAGES } from "@/lib/connections/messages";

// The dashboard may not import server modules (D23), so its copies of server enums that are
// not part of a v1 return type are pinned here: a new server value fails this test until the
// dashboard handles it.

describe("dashboard ↔ server parity", () => {
  it("knows every OAuth callback error code", () => {
    expect([...CALLBACK_ERRORS]).toEqual([...CALLBACK_ERROR_CODES]);
  });

  it("has a Google Ads and a Meta Ads message for exactly the published error reasons", () => {
    expect(Object.keys(ERROR_REASON_MESSAGES).sort()).toEqual([...SYNC_ERROR_REASONS].sort());
    expect(Object.keys(META_ERROR_REASON_MESSAGES).sort()).toEqual([...SYNC_ERROR_REASONS].sort());
  });
});
