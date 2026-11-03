import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { isMarketingError } from "../lib/errors";
import { as, ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg } from "../test.helpers";
import { SAVED_REPLY_STARTERS } from "../../lib/messaging/saved-reply-starters";
import { checkSavedReply, MAX_SAVED_REPLIES } from "./savedReplies";

// ADR 0021: saved replies, the pure checks and the public API (roles, tenancy, limits). The
// dashboard's ready-made replies must all pass the server's checks.

const ORG_B = { issuer: ISSUER_CRM, org: "77", sub: "user_b", role: "admin" };

async function setup() {
  const t = newBackend();
  await seedOrg(t, ISSUER_ERP, "42");
  await seedOrg(t, ISSUER_CRM, "77");
  return t;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isMarketingError(error)) throw error;
    return error.data;
  }
  throw new Error("expected the call to fail");
}

const reply = {
  title: "Opening hours",
  text: "We're open 10 to 8, {{customer_name}}.",
  channels: ["instagram", "whatsapp"] as ("instagram" | "whatsapp")[],
};

describe("checkSavedReply", () => {
  it("trims, orders the channels and keeps Instagram quick replies", () => {
    expect(checkSavedReply({ ...reply, title: " Hours ", quickReplies: [" Yes ", "No"] })).toEqual({
      ok: true,
      value: {
        title: "Hours",
        text: "We're open 10 to 8, {{customer_name}}.",
        channels: ["whatsapp", "instagram"],
        quickReplies: ["Yes", "No"],
      },
    });
  });

  it.each([
    [{ title: " " }, "title_missing", "title"],
    [{ title: "t".repeat(61) }, "title_too_long", "title"],
    [{ text: "  " }, "text_missing", "text"],
    [{ channels: [] }, "no_channel", "channels"],
    [{ text: "é".repeat(501) }, "text_too_long", "text"],
    [{ channels: ["whatsapp"], text: "x".repeat(4097) }, "text_too_long", "text"],
    [
      { channels: ["whatsapp"], quickReplies: ["Yes"] },
      "quick_replies_instagram_only",
      "quickReplies",
    ],
    [
      { quickReplies: Array.from({ length: 14 }, (_, i) => `q${i}`) },
      "too_many_quick_replies",
      "quickReplies",
    ],
    [{ quickReplies: ["ok", "x".repeat(21)] }, "quick_reply_text", "quickReplies.1"],
    [{ quickReplies: ["ok", "ok"] }, "duplicate_quick_reply", "quickReplies.1"],
  ])("refuses %j", (overrides, reason, field) => {
    expect(checkSavedReply({ ...reply, ...(overrides as object) })).toEqual({
      ok: false,
      reason,
      field,
    });
  });

  it("accepts every ready-made reply of the dashboard", () => {
    for (const starter of SAVED_REPLY_STARTERS) {
      expect(checkSavedReply(starter).ok, starter.id).toBe(true);
    }
  });
});

describe("v1/savedReplies", () => {
  it("lets editors add, change and delete replies; every member reads them, by channel", async () => {
    const t = await setup();
    const created = await as(t, { role: "editor" }).mutation(api.v1.savedReplies.create, reply);
    await as(t).mutation(api.v1.savedReplies.create, {
      title: "Bulk orders",
      text: "Yes, we take bulk orders.",
      channels: ["whatsapp"],
    });
    const viewer = as(t, { role: "viewer" });
    expect((await viewer.query(api.v1.savedReplies.list, {})).map((r) => r.title)).toEqual([
      "Bulk orders",
      "Opening hours",
    ]);
    expect(
      (await viewer.query(api.v1.savedReplies.list, { channel: "instagram" })).map((r) => r.title),
    ).toEqual(["Opening hours"]);

    const updated = await as(t, { role: "editor" }).mutation(api.v1.savedReplies.update, {
      savedReplyId: created.id,
      ...reply,
      text: "Open 9 to 9.",
      quickReplies: ["Directions"],
    });
    expect(updated).toMatchObject({ text: "Open 9 to 9.", quickReplies: ["Directions"] });
    const row = await t.run((ctx) => ctx.db.get(created.id as never));
    expect(row).toMatchObject({ createdBySubject: "user_1", updatedBySubject: "user_1" });

    await as(t, { role: "editor" }).mutation(api.v1.savedReplies.remove, {
      savedReplyId: created.id,
    });
    expect((await viewer.query(api.v1.savedReplies.list, {})).map((r) => r.title)).toEqual([
      "Bulk orders",
    ]);
  });

  it("is read-only for viewers", async () => {
    const t = await setup();
    const data = await refusal(
      as(t, { role: "viewer" }).mutation(api.v1.savedReplies.create, reply),
    );
    expect(data.code).toBe("FORBIDDEN");
  });

  it("keeps each org's replies to itself", async () => {
    const t = await setup();
    const mine = await as(t).mutation(api.v1.savedReplies.create, reply);
    expect(await as(t, ORG_B).query(api.v1.savedReplies.list, {})).toEqual([]);
    for (const call of [
      as(t, ORG_B).mutation(api.v1.savedReplies.update, { savedReplyId: mine.id, ...reply }),
      as(t, ORG_B).mutation(api.v1.savedReplies.remove, { savedReplyId: mine.id }),
    ]) {
      expect((await refusal(call)).code).toBe("NOT_FOUND");
    }
  });

  it("refuses an invalid reply, a title in use and more than the limit", async () => {
    const t = await setup();
    const invalid = await refusal(
      as(t).mutation(api.v1.savedReplies.create, { ...reply, text: "" }),
    );
    expect(invalid).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "text_missing" },
    });
    const first = await as(t).mutation(api.v1.savedReplies.create, reply);
    const second = await as(t).mutation(api.v1.savedReplies.create, { ...reply, title: "Other" });
    expect(
      (await refusal(as(t).mutation(api.v1.savedReplies.create, reply))).details,
    ).toMatchObject({
      reason: "title_in_use",
    });
    expect(
      (
        await refusal(
          as(t).mutation(api.v1.savedReplies.update, { savedReplyId: second.id, ...reply }),
        )
      ).details,
    ).toMatchObject({ reason: "title_in_use" });
    // Renaming a reply to its own title is fine.
    await as(t).mutation(api.v1.savedReplies.update, { savedReplyId: first.id, ...reply });

    await t.run(async (ctx) => {
      const org = (await ctx.db.query("organizations").collect())[0]!;
      for (let i = 0; i < MAX_SAVED_REPLIES - 2; i++) {
        await ctx.db.insert("savedReplies", {
          orgId: org._id,
          title: `Filler ${String(i).padStart(3, "0")}`,
          text: "x",
          channels: ["whatsapp"],
          createdBySubject: "user_1",
          updatedBySubject: "user_1",
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    const full = await refusal(
      as(t).mutation(api.v1.savedReplies.create, { ...reply, title: "One more" }),
    );
    expect(full).toMatchObject({ code: "CONFLICT", details: { reason: "limit_reached" } });
  });
});
