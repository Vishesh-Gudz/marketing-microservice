import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_DELIVERY, MAX_TEXT_BODY_CHARS } from "./config";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  PHONE_A,
  WABA_A,
  delivery,
  entry,
  message,
} from "./fakeWebhook.fixtures";
import { parseWebhookPayload } from "./payload";

function ok(body: unknown) {
  const result = parseWebhookPayload(body);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.delivery;
}

describe("parseWebhookPayload: envelope (rejected as a whole)", () => {
  it.each([
    ["not an object", "text", "not_object"],
    ["an array", [], "not_object"],
    ["null", null, "not_object"],
    ["another object type", { object: "page", entry: [] }, "wrong_object"],
    ["entry missing", { object: "whatsapp_business_account" }, "invalid_entry"],
    ["entry not an array", { object: "whatsapp_business_account", entry: {} }, "invalid_entry"],
    [
      "entry id not numeric",
      { object: "whatsapp_business_account", entry: [{ id: "abc", changes: [] }] },
      "invalid_entry",
    ],
    [
      "changes missing",
      { object: "whatsapp_business_account", entry: [{ id: WABA_A }] },
      "invalid_entry",
    ],
    [
      "change without value",
      {
        object: "whatsapp_business_account",
        entry: [{ id: WABA_A, changes: [{ field: "messages" }] }],
      },
      "invalid_change",
    ],
  ])("rejects %s", (_label, body, reason) => {
    expect(parseWebhookPayload(body)).toEqual({ ok: false, reason });
  });

  it("rejects a messages change without a numeric phone_number_id", () => {
    const body = delivery(entry({ messages: [{ id: "wamid.1" }] }));
    const value = (body.entry as { changes: { value: Record<string, unknown> }[] }[])[0]!
      .changes[0]!.value;
    value.metadata = { phone_number_id: "not-a-number" };
    expect(parseWebhookPayload(body)).toEqual({ ok: false, reason: "invalid_metadata" });
    delete value.metadata;
    expect(parseWebhookPayload(body)).toEqual({ ok: false, reason: "invalid_metadata" });
  });

  it("rejects a messages change from another messaging product", () => {
    const body = delivery(
      entry({ messages: [{ id: "wamid.1" }], extraValue: { messaging_product: "sms" } }),
    );
    expect(parseWebhookPayload(body)).toEqual({ ok: false, reason: "invalid_metadata" });
  });

  it("rejects messages / statuses / contacts that are not arrays", () => {
    for (const key of ["messages", "statuses", "contacts"]) {
      const body = delivery(entry({ extraValue: { [key]: { id: "x" } } }));
      expect(parseWebhookPayload(body)).toEqual({ ok: false, reason: "invalid_change" });
    }
  });

  it("rejects deliveries with more events than the limit", () => {
    const messages = Array.from({ length: MAX_EVENTS_PER_DELIVERY + 1 }, (_, i) => ({
      id: `wamid.${i}`,
    }));
    expect(parseWebhookPayload(delivery(entry({ messages })))).toEqual({
      ok: false,
      reason: "too_many_events",
    });
  });
});

describe("parseWebhookPayload: events", () => {
  it("normalizes text messages with the sender's profile name", () => {
    const parsed = ok(
      delivery(
        entry({
          messages: [
            {
              id: "wamid.A",
              from: CUSTOMER_1,
              timestamp: 1_700_000_000,
              text: "Hi there",
              name: "Ana",
            },
          ],
        }),
      ),
    );
    expect(parsed).toEqual({
      changes: [
        {
          wabaId: WABA_A,
          phoneNumberId: PHONE_A,
          events: [
            {
              kind: "message",
              wamid: "wamid.A",
              from: CUSTOMER_1,
              contactName: "Ana",
              timestampMs: 1_700_000_000_000,
              messageType: "text",
              text: "Hi there",
            },
          ],
        },
      ],
      skipped: 0,
      ignoredFields: 0,
    });
  });

  it("keeps only allowlisted fields (an org id in the payload is ignored)", () => {
    const body = delivery(
      entry({ messages: [{ id: "wamid.A" }], extraValue: { orgId: "x", org_id: "y" } }),
    );
    (body as Record<string, unknown>).orgId = "attacker-org";
    const event = ok(body).changes[0]!.events[0]!;
    expect(Object.keys(event).sort()).toEqual(
      ["kind", "wamid", "from", "timestampMs", "messageType", "text"].sort(),
    );
  });

  it("records non-text types by type only and unknown types as unsupported", () => {
    const parsed = ok(
      delivery(
        entry({
          messages: [
            { id: "wamid.img", type: "image" },
            { id: "wamid.new", type: "some_future_type" },
          ],
        }),
      ),
    );
    expect(parsed.changes[0]!.events.map((e) => e.kind === "message" && e.messageType)).toEqual([
      "image",
      "unsupported",
    ]);
    expect(parsed.changes[0]!.events.every((e) => !("text" in e))).toBe(true);
  });

  it("skips invalid items but keeps the valid ones", () => {
    const body = delivery(entry({ messages: [{ id: "wamid.ok" }] }));
    const value = (
      body.entry as { changes: { value: { messages: unknown[]; statuses?: unknown[] } }[] }[]
    )[0]!.changes[0]!.value;
    value.messages.push(
      { ...message({ id: "wamid.x" }), id: undefined },
      { ...message({ id: "wamid.y" }), from: "+1 555" },
      { ...message({ id: "wamid.z" }), timestamp: "soon" },
      { ...message({ id: "wamid.t" }), text: { body: "" } },
      { ...message({ id: "wamid.u" }), text: { body: "x".repeat(MAX_TEXT_BODY_CHARS + 1) } },
      { ...message({ id: "wamid.w" }), type: "Text!" },
      { ...message({ id: "has space" }) },
      "not an object",
    );
    value.statuses = [
      { id: "wamid.s", status: "played", timestamp: "1", recipient_id: CUSTOMER_1 },
      { id: "wamid.s", status: "sent", timestamp: "1" },
    ];
    const parsed = ok(body);
    expect(parsed.skipped).toBe(10);
    expect(parsed.changes[0]!.events.map((e) => e.wamid)).toEqual(["wamid.ok"]);
  });

  it("normalizes statuses and keeps only the numeric error code of a failure", () => {
    const parsed = ok(
      delivery(
        entry({
          statuses: [
            { id: "wamid.1", status: "delivered", timestamp: 1_700_000_100, recipient: CUSTOMER_2 },
            { id: "wamid.2", status: "failed", timestamp: 1_700_000_200, errorCode: 131047 },
          ],
        }),
      ),
    );
    expect(parsed.changes[0]!.events).toEqual([
      {
        kind: "status",
        wamid: "wamid.1",
        status: "delivered",
        timestampMs: 1_700_000_100_000,
        recipientWaId: CUSTOMER_2,
      },
      {
        kind: "status",
        wamid: "wamid.2",
        status: "failed",
        timestampMs: 1_700_000_200_000,
        recipientWaId: CUSTOMER_1,
        errorCode: 131047,
      },
    ]);
  });

  it("ignores other subscribed fields and empty changes", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_A,
          changes: [
            { field: "message_template_status_update", value: { event: "APPROVED" } },
            {
              field: "messages",
              value: { messaging_product: "whatsapp", metadata: { phone_number_id: PHONE_A } },
            },
          ],
        },
      ],
    };
    expect(ok(body)).toEqual({ changes: [], skipped: 0, ignoredFields: 1 });
  });
});
