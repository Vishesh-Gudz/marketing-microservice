import { describe, expect, it } from "vitest";
import { MAX_FUTURE_SKEW_MS } from "../../messaging/window";
import { MAX_EVENTS_PER_DELIVERY } from "./config";
import {
  CUSTOMER_1,
  customerMessage,
  deleted,
  delivery,
  echo,
  edited,
  entry,
  IG_ACCOUNT,
  seen,
} from "./fakeWebhook.fixtures";
import { parseWebhookPayload } from "./payload";

// ADR 0017 (IM2): the strict parser for Instagram messaging deliveries. Payloads follow Meta's
// documented examples; they are not evidence of real Meta behavior.

const NOW = Date.UTC(2026, 9, 29, 12);
const at = { timestamp: NOW - 1_000 };

function parse(...items: Record<string, unknown>[]) {
  const result = parseWebhookPayload(delivery(entry(items)), NOW);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

const events = (...items: Record<string, unknown>[]) => parse(...items).entries[0]?.events ?? [];

describe("parseWebhookPayload", () => {
  it("reads customer messages, echoes, seen, edits and deletions with the customer's side", () => {
    const result = parse(
      customerMessage("m.1", { ...at, text: "Do you ship?" }),
      echo("m.2", at),
      seen("m.2", at),
      edited("m.1", "Do you ship to Lisbon?", 1, at),
      deleted("m.1", at),
    );
    expect(result).toMatchObject({ skipped: 0, ignored: 0 });
    const base = { customerIgsid: CUSTOMER_1, timestampMs: at.timestamp };
    expect(result.entries).toEqual([
      {
        igAccountId: IG_ACCOUNT,
        events: [
          { kind: "message", mid: "m.1", ...base, messageType: "text", text: "Do you ship?" },
          { kind: "echo", mid: "m.2", ...base, messageType: "text", text: "hi there" },
          { kind: "read", mid: "m.2", ...base },
          {
            kind: "edit",
            mid: "m.1",
            ...base,
            text: "Do you ship to Lisbon?",
            editCount: 1,
          },
          { kind: "delete", mid: "m.1", ...base },
        ],
      },
    ]);
  });

  it("keeps attachments as typed placeholders and never copies a URL", () => {
    const url = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1";
    const attachment = (type: string) => ({
      text: undefined,
      attachments: [{ type, payload: { url } }],
    });
    const result = events(
      customerMessage("m.1", { ...at, message: attachment("image") }),
      customerMessage("m.2", { ...at, message: attachment("something_new") }),
      customerMessage("m.3", { ...at, message: { reply_to: { story: { url, id: "1" } } } }),
      customerMessage("m.4", { ...at, message: { is_unsupported: true, text: undefined } }),
      customerMessage("m.5", { ...at, message: { reply_to: { mid: "m.1" } } }),
    );
    expect(result.map((e) => "messageType" in e && e.messageType)).toEqual([
      "image",
      "unsupported",
      "story_reply",
      "unsupported",
      "text",
    ]);
    expect(result[4]).toMatchObject({ replyToMid: "m.1" });
    expect(JSON.stringify(result)).not.toContain("https");
  });

  it("ignores reactions, postbacks, self-messaging tests and entries without messaging", () => {
    const result = parseWebhookPayload(
      delivery(
        entry([
          {
            sender: { id: CUSTOMER_1 },
            recipient: { id: IG_ACCOUNT },
            timestamp: NOW,
            reaction: { mid: "m.1", action: "react" },
          },
          {
            sender: { id: CUSTOMER_1 },
            recipient: { id: IG_ACCOUNT },
            timestamp: NOW,
            postback: { mid: "m.2", payload: "p" },
          },
          customerMessage("m.3", { ...at, message: { is_self: true } }),
        ]),
        { id: IG_ACCOUNT, time: NOW, changes: [{ field: "comments", value: {} }] },
        { id: IG_ACCOUNT, time: NOW, standby: [] },
      ),
      NOW,
    );
    expect(result).toEqual({ ok: true, entries: [], skipped: 0, ignored: 5 });
  });

  it.each([
    ["sent to another account", customerMessage("m.1", { ...at, account: "17841400000000999" })],
    ["an echo not sent by the account", echo("m.1", { ...at, account: "17841400000000999" })],
    ["a non-numeric customer id", customerMessage("m.1", { ...at, customer: "abc" })],
    [
      "a customer id as an inexact number",
      { ...customerMessage("m.1", at), sender: { id: 2 ** 60 } },
    ],
    ["a timestamp in seconds", customerMessage("m.1", { timestamp: Math.floor(NOW / 1000) })],
    [
      "a timestamp in the future",
      customerMessage("m.1", { timestamp: NOW + MAX_FUTURE_SKEW_MS + 1 }),
    ],
    ["a timestamp as a string", { ...customerMessage("m.1"), timestamp: String(NOW) }],
    ["a missing mid", customerMessage("", at)],
    ["no text and no attachment", customerMessage("m.1", { ...at, message: { text: undefined } })],
    ["text that is not a string", customerMessage("m.1", { ...at, message: { text: 42 } })],
    [
      "an edit without a count",
      { ...edited("m.1", "x", 1, at), message_edit: { mid: "m.1", text: "x" } },
    ],
  ])("skips an event with %s", (_case, item) => {
    expect(parse(item)).toEqual({ ok: true, entries: [], skipped: 1, ignored: 0 });
  });

  it("keeps 17-digit account ids exact and rejects them as inexact JSON numbers", () => {
    expect(parse(customerMessage("m.1", at)).entries[0]?.igAccountId).toBe("17841400000000101");
    const raw = JSON.stringify(delivery(entry([customerMessage("m.1", at)]))).replace(
      `"id":"${IG_ACCOUNT}","time"`,
      `"id":${IG_ACCOUNT},"time"`,
    );
    expect(parseWebhookPayload(JSON.parse(raw), NOW)).toEqual({
      ok: false,
      reason: "invalid_entry",
    });
  });

  it.each([
    ["not an object", [], "not_object"],
    ["another product", { object: "page", entry: [] }, "wrong_object"],
    ["entry not a list", { object: "instagram", entry: {} }, "invalid_entry"],
    [
      "an entry without an id",
      { object: "instagram", entry: [{ messaging: [] }] },
      "invalid_entry",
    ],
    [
      "messaging not a list",
      { object: "instagram", entry: [{ id: IG_ACCOUNT, messaging: {} }] },
      "invalid_entry",
    ],
    [
      "too many events",
      delivery(
        entry(
          Array.from({ length: MAX_EVENTS_PER_DELIVERY + 1 }, (_, i) =>
            customerMessage(`m.${i}`, at),
          ),
        ),
      ),
      "too_many_events",
    ],
  ])("rejects a delivery that is %s", (_case, body, reason) => {
    expect(parseWebhookPayload(body, NOW)).toEqual({ ok: false, reason });
  });
});
