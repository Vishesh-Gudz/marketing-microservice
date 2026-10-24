import { describe, expect, it } from "vitest";
import {
  businessNumberLabel,
  contactLabel,
  isReplyWindowOpen,
  messageContent,
  OUTBOUND_STATUS_LABELS,
  outboundStatusLabel,
} from "./inbox";

describe("inbox labels", () => {
  it("names a contact by their WhatsApp profile name, else their number", () => {
    expect(contactLabel({ contactName: "Ana", contactWaId: "15550001111" })).toBe("Ana");
    expect(contactLabel({ contactWaId: "15550001111" })).toBe("+15550001111");
  });

  it("shows the business number as WhatsApp displays it, else its id", () => {
    expect(
      businessNumberLabel({ displayPhoneNumber: "+1 555-000-0001", phoneNumberId: "200" }),
    ).toBe("+1 555-000-0001");
    expect(businessNumberLabel({ phoneNumberId: "200000000000001" })).toBe("200000000000001");
  });

  it("gives every outbound status words, and inbound messages none", () => {
    expect(Object.keys(OUTBOUND_STATUS_LABELS).sort()).toEqual([
      "delivered",
      "failed",
      "pending",
      "read",
      "sent",
      "submitted",
      "unknown",
    ]);
    expect(outboundStatusLabel("read")).toBe("Read");
    expect(outboundStatusLabel("unknown")).toBe("Not confirmed");
    expect(outboundStatusLabel("received")).toBeUndefined();
  });
});

describe("isReplyWindowOpen", () => {
  const expiresAt = "2026-10-25T12:00:00.000Z";
  const at = Date.parse(expiresAt);

  it("is open until the window's end, and closed from that instant on", () => {
    expect(isReplyWindowOpen(expiresAt, at - 1)).toBe(true);
    expect(isReplyWindowOpen(expiresAt, at)).toBe(false);
    expect(isReplyWindowOpen(expiresAt, at + 60_000)).toBe(false);
  });

  it("is closed when the customer has not written", () => {
    expect(isReplyWindowOpen(undefined, at)).toBe(false);
  });
});

describe("messageContent", () => {
  it("shows a message's text as it is", () => {
    expect(messageContent({ type: "text", text: "<b>hi</b>\nthere" })).toEqual({
      kind: "text",
      text: "<b>hi</b>\nthere",
    });
  });

  it.each([
    ["image", "Photo (not shown in this inbox)"],
    ["location", "Location (not shown in this inbox)"],
    ["reaction", "Reaction (not shown in this inbox)"],
    ["unsupported", "Unsupported message (not shown in this inbox)"],
    ["text", "Message (not shown in this inbox)"],
  ] as const)("shows a fixed placeholder for a %s message without text", (type, text) => {
    expect(messageContent({ type })).toEqual({ kind: "placeholder", text });
  });
});
