import { describe, expect, it } from "vitest";
import { api } from "../../_generated/api";
import { isMarketingError } from "../../lib/errors";
import { as, ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg } from "../../test.helpers";
import { INSTAGRAM_TEMPLATE_STARTERS } from "../../../lib/instagram/template-starters";
import {
  checkInstagramTemplate,
  fillTemplate,
  isPublicHttpsUrl,
  MAX_INSTAGRAM_TEMPLATES,
  templateAttachment,
  type TemplateContent,
} from "./templates";

// ADR 0022: Instagram templates, the pure checks, Meta's attachment body and the public API
// (roles, tenancy, limits). The dashboard's ready-made templates must all pass the server's
// checks.

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

const buttons: TemplateContent = {
  kind: "buttons",
  text: "Hi {{customer_name}}, what can we do for you?",
  buttons: [
    { type: "reply", title: "Prices" },
    { type: "url", title: "Our shop", url: "https://shop.example.com/new" },
  ],
};

const cards: TemplateContent = {
  kind: "cards",
  cards: [
    {
      title: "Linen shirt",
      subtitle: "€49 · Made in Portugal",
      imageUrl: "https://cdn.example.com/shirt.jpg",
      linkUrl: "https://shop.example.com/shirt",
      buttons: [
        { type: "url", title: "View", url: "https://shop.example.com/shirt" },
        { type: "reply", title: "I want this" },
      ],
    },
    { title: "Gift card", subtitle: "From €20", buttons: [] },
  ],
};

const template = { name: "Welcome", content: buttons };

describe("checkInstagramTemplate", () => {
  it("trims everything and leaves out empty optional parts", () => {
    expect(
      checkInstagramTemplate({
        name: " Picks ",
        content: {
          kind: "cards",
          cards: [
            {
              title: " Shirt ",
              subtitle: "  ",
              imageUrl: "",
              linkUrl: " https://shop.example.com ",
              buttons: [{ type: "reply", title: " Yes " }],
            },
          ],
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Picks",
        content: {
          kind: "cards",
          cards: [
            {
              title: "Shirt",
              linkUrl: "https://shop.example.com",
              buttons: [{ type: "reply", title: "Yes" }],
            },
          ],
        },
      },
    });
  });

  const reply = (title: string) => ({ type: "reply" as const, title });
  const card = (overrides: object) => ({
    title: "Shirt",
    subtitle: "€49",
    buttons: [],
    ...overrides,
  });
  it.each<[object, string, string]>([
    [{ name: " " }, "name_missing", "name"],
    [{ name: "n".repeat(61) }, "name_too_long", "name"],
    [{ content: { ...buttons, text: " " } }, "text_missing", "content.text"],
    [{ content: { ...buttons, text: "x".repeat(641) } }, "text_too_long", "content.text"],
    [{ content: { ...buttons, text: "Hi {{name}}" } }, "unknown_placeholder", "content.text"],
    [{ content: { ...buttons, buttons: [] } }, "button_count", "content.buttons"],
    [
      { content: { ...buttons, buttons: [reply("a"), reply("b"), reply("c"), reply("d")] } },
      "button_count",
      "content.buttons",
    ],
    [
      { content: { ...buttons, buttons: [reply("x".repeat(21))] } },
      "button_title",
      "content.buttons.0.title",
    ],
    [
      { content: { ...buttons, buttons: [reply("Yes"), reply(" Yes ")] } },
      "duplicate_button",
      "content.buttons.1.title",
    ],
    [
      { content: { ...buttons, buttons: [reply("Hi {{customer_name}}")] } },
      "unknown_placeholder",
      "content.buttons.0.title",
    ],
    ...(
      [
        "http://shop.example.com",
        "https://localhost/x",
        "https://127.0.0.1/x",
        "https://user:pw@shop.example.com",
        "javascript:alert(1)",
        "https://shop.example.com/{{customer_name}}",
        "https://shop.example.com/a b",
      ] as const
    ).map((url): [object, string, string] => [
      { content: { ...buttons, buttons: [{ type: "url", title: "Go", url }] } },
      "button_url",
      "content.buttons.0.url",
    ]),
    [{ content: { kind: "cards", cards: [] } }, "card_count", "content.cards"],
    [
      { content: { kind: "cards", cards: Array.from({ length: 11 }, () => card({})) } },
      "card_count",
      "content.cards",
    ],
    [
      { content: { kind: "cards", cards: [card({ title: "" })] } },
      "card_title",
      "content.cards.0.title",
    ],
    [
      { content: { kind: "cards", cards: [card({ title: "t".repeat(81) })] } },
      "card_title",
      "content.cards.0.title",
    ],
    [
      { content: { kind: "cards", cards: [card({ subtitle: "s".repeat(81) })] } },
      "card_subtitle",
      "content.cards.0.subtitle",
    ],
    [
      { content: { kind: "cards", cards: [card({ imageUrl: "ftp://x.example.com/a.jpg" })] } },
      "card_image_url",
      "content.cards.0.imageUrl",
    ],
    [
      { content: { kind: "cards", cards: [card({ linkUrl: "shop" })] } },
      "card_link_url",
      "content.cards.0.linkUrl",
    ],
    [
      { content: { kind: "cards", cards: [card({}), card({ subtitle: undefined })] } },
      "card_needs_more",
      "content.cards.1",
    ],
    [
      {
        content: {
          kind: "cards",
          cards: [card({ buttons: [reply("a"), reply("b"), reply("c"), reply("d")] })],
        },
      },
      "button_count",
      "content.cards.0.buttons",
    ],
  ])("refuses %j", (overrides, reason, field) => {
    expect(checkInstagramTemplate({ ...template, ...(overrides as object) })).toEqual({
      ok: false,
      reason,
      field,
    });
  });

  it("accepts a public https address only", () => {
    expect(isPublicHttpsUrl("https://shop.example.com/a?b=1#c")).toBe(true);
    expect(isPublicHttpsUrl(`https://shop.example.com/${"a".repeat(1000)}`)).toBe(false);
  });

  it("accepts every ready-made template of the dashboard", () => {
    for (const starter of INSTAGRAM_TEMPLATE_STARTERS) {
      expect(checkInstagramTemplate(starter).ok, starter.id).toBe(true);
    }
  });
});

describe("fillTemplate", () => {
  it("fills the customer's first name, or leaves it out with the comma before it", () => {
    expect(fillTemplate(buttons, "Ana Lima")).toMatchObject({
      text: "Hi Ana, what can we do for you?",
    });
    expect(fillTemplate(buttons, undefined)).toMatchObject({ text: "Hi, what can we do for you?" });
    expect(
      fillTemplate(
        {
          kind: "cards",
          cards: [
            { title: "For you, {{customer_name}}", subtitle: "{{customer_name}}", buttons: [] },
          ],
        },
        undefined,
      ),
    ).toEqual({ kind: "cards", cards: [{ title: "For you", buttons: [] }] });
  });
});

describe("templateAttachment", () => {
  it("builds Meta's button template; reply buttons carry only their position", () => {
    expect(templateAttachment(fillTemplate(buttons, "Ana"))).toEqual({
      type: "template",
      payload: {
        template_type: "button",
        text: "Hi Ana, what can we do for you?",
        buttons: [
          { type: "postback", title: "Prices", payload: "TEMPLATE_REPLY_1" },
          { type: "web_url", url: "https://shop.example.com/new", title: "Our shop" },
        ],
      },
    });
  });

  it("builds Meta's generic template, one element per card", () => {
    expect(templateAttachment(cards)).toEqual({
      type: "template",
      payload: {
        template_type: "generic",
        elements: [
          {
            title: "Linen shirt",
            subtitle: "€49 · Made in Portugal",
            image_url: "https://cdn.example.com/shirt.jpg",
            default_action: { type: "web_url", url: "https://shop.example.com/shirt" },
            buttons: [
              { type: "web_url", url: "https://shop.example.com/shirt", title: "View" },
              { type: "postback", title: "I want this", payload: "TEMPLATE_REPLY_1_2" },
            ],
          },
          { title: "Gift card", subtitle: "From €20" },
        ],
      },
    });
  });
});

describe("v1/instagramTemplates", () => {
  it("lets editors add, change and delete templates; every member reads them", async () => {
    const t = await setup();
    const editor = as(t, { role: "editor" });
    const created = await editor.mutation(api.v1.instagramTemplates.create, template);
    await as(t).mutation(api.v1.instagramTemplates.create, { name: "Picks", content: cards });
    const viewer = as(t, { role: "viewer" });
    expect((await viewer.query(api.v1.instagramTemplates.list, {})).map((r) => r.name)).toEqual([
      "Picks",
      "Welcome",
    ]);

    const updated = await editor.mutation(api.v1.instagramTemplates.update, {
      templateId: created.id,
      name: "Welcome",
      content: { ...buttons, text: "Hello!" },
    });
    expect(updated.content).toMatchObject({ text: "Hello!" });
    const row = await t.run((ctx) => ctx.db.get(created.id as never));
    expect(row).toMatchObject({ createdBySubject: "user_1", updatedBySubject: "user_1" });

    await editor.mutation(api.v1.instagramTemplates.remove, { templateId: created.id });
    expect((await viewer.query(api.v1.instagramTemplates.list, {})).map((r) => r.name)).toEqual([
      "Picks",
    ]);
  });

  it("is read-only for viewers", async () => {
    const t = await setup();
    const data = await refusal(
      as(t, { role: "viewer" }).mutation(api.v1.instagramTemplates.create, template),
    );
    expect(data.code).toBe("FORBIDDEN");
  });

  it("keeps each org's templates to itself", async () => {
    const t = await setup();
    const mine = await as(t).mutation(api.v1.instagramTemplates.create, template);
    expect(await as(t, ORG_B).query(api.v1.instagramTemplates.list, {})).toEqual([]);
    for (const call of [
      as(t, ORG_B).mutation(api.v1.instagramTemplates.update, { templateId: mine.id, ...template }),
      as(t, ORG_B).mutation(api.v1.instagramTemplates.remove, { templateId: mine.id }),
    ]) {
      expect((await refusal(call)).code).toBe("NOT_FOUND");
    }
  });

  it("refuses an invalid template, a name in use and more than the limit", async () => {
    const t = await setup();
    const invalid = await refusal(
      as(t).mutation(api.v1.instagramTemplates.create, {
        ...template,
        content: { ...buttons, buttons: [] },
      }),
    );
    expect(invalid).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "button_count", field: "content.buttons" },
    });
    const first = await as(t).mutation(api.v1.instagramTemplates.create, template);
    const second = await as(t).mutation(api.v1.instagramTemplates.create, {
      ...template,
      name: "Other",
    });
    expect(
      (await refusal(as(t).mutation(api.v1.instagramTemplates.create, template))).details,
    ).toMatchObject({ reason: "name_in_use" });
    expect(
      (
        await refusal(
          as(t).mutation(api.v1.instagramTemplates.update, { templateId: second.id, ...template }),
        )
      ).details,
    ).toMatchObject({ reason: "name_in_use" });
    // Keeping its own name is fine.
    await as(t).mutation(api.v1.instagramTemplates.update, { templateId: first.id, ...template });

    await t.run(async (ctx) => {
      const org = (await ctx.db.query("organizations").collect())[0]!;
      for (let i = 0; i < MAX_INSTAGRAM_TEMPLATES - 2; i++) {
        await ctx.db.insert("instagramTemplates", {
          orgId: org._id,
          name: `Filler ${String(i).padStart(3, "0")}`,
          content: buttons,
          createdBySubject: "user_1",
          updatedBySubject: "user_1",
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    const full = await refusal(
      as(t).mutation(api.v1.instagramTemplates.create, { ...template, name: "One more" }),
    );
    expect(full).toMatchObject({ code: "CONFLICT", details: { reason: "limit_reached" } });
  });
});
