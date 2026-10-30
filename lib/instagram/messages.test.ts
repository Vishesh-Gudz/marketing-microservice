import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  contactLabel,
  deliveryProblemText,
  messageContent,
  MAX_REPLY_BYTES,
  outboundStatusLabel,
  sendErrorNotice,
  setupReasonText,
  utf8Length,
} from "./messages";

// Instagram direct messages in fixed words (ADR 0017, IM5): byte counting as Instagram counts,
// labels that never show a customer's Instagram id, and no server or Meta text.

describe("utf8Length", () => {
  it.each([
    ["a".repeat(MAX_REPLY_BYTES), 1000],
    ["é", 2],
    ["€", 3],
    ["😀", 4],
    ["😀".repeat(250), 1000],
  ])("counts UTF-8 bytes, not characters", (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes);
  });
});

describe("labels", () => {
  it("names the contact by username, else name, else neutrally", () => {
    expect(contactLabel({ contactUsername: "ana.shop", contactName: "Ana" })).toBe("@ana.shop");
    expect(contactLabel({ contactName: "Ana" })).toBe("Ana");
    expect(contactLabel({})).toBe("Instagram user");
  });

  it("names every reply status, none for a received message", () => {
    expect(
      (["pending", "submitted", "sent", "read", "failed", "unknown"] as const).map(
        outboundStatusLabel,
      ),
    ).toEqual(["Sending", "Accepted by Instagram", "Sent", "Seen", "Not sent", "Not confirmed"]);
    expect(outboundStatusLabel("received")).toBeUndefined();
  });

  it("shows placeholders for attachments and deleted messages, never a URL", () => {
    expect(messageContent({ type: "image", direction: "inbound" })).toEqual({
      kind: "placeholder",
      text: "Photo (not shown in this inbox)",
    });
    expect(
      messageContent({ type: "text", text: "gone", deletedAt: "x", direction: "inbound" }),
    ).toEqual({ kind: "placeholder", text: "The customer deleted this message" });
    expect(messageContent({ type: "text", text: "Hi", direction: "outbound" })).toEqual({
      kind: "text",
      text: "Hi",
    });
  });
});

describe("problems in fixed words", () => {
  it("is honest about an unconfirmed reply and never offers to resend it", () => {
    const text = deliveryProblemText({ status: "unknown" })!;
    expect(text).toMatch(/may have been sent/);
    expect(text).toMatch(/before sending it again/);
  });

  it("explains failed replies without Meta's codes", () => {
    expect(deliveryProblemText({ status: "failed", failureReason: "window_closed" })).toMatch(
      /24-hour reply window/,
    );
    expect(deliveryProblemText({ status: "failed", failureReason: "meta_190" })).toMatch(
      /Reconnect/,
    );
    expect(deliveryProblemText({ status: "failed", failureReason: "credential_invalid" })).toMatch(
      /Reconnect/,
    );
    const other = deliveryProblemText({ status: "failed", failureReason: "meta_10" })!;
    expect(other).toBe("Instagram refused this reply.");
  });

  it("never says Instagram refused a reply it was never sent", () => {
    for (const failureReason of ["not_sent", "transport_blocked", "request_budget_exceeded"]) {
      expect(deliveryProblemText({ status: "failed", failureReason })).toBe(
        "It could not be sent. Try again.",
      );
    }
    expect(deliveryProblemText({ status: "sent" })).toBeNull();
  });

  it("maps refusals to fixed notices, never the server's text", () => {
    const window = sendErrorNotice(
      apiError("CONFLICT", "server words", { reason: "window_closed" }),
    );
    expect(window).toMatchObject({ tone: "warning", title: "Reply window closed" });
    expect(JSON.stringify(window)).not.toContain("server words");
    expect(sendErrorNotice(apiError("INVALID_ARGUMENT", "x", { field: "text" })).message).toMatch(
      /1,000 bytes/,
    );
    expect(sendErrorNotice(new Error("boom")).title).toBe("Message not sent");
  });

  it("explains a setup that did not finish by its sanitized reason", () => {
    expect(setupReasonText("timeout")).toMatch(/did not answer/);
    expect(setupReasonText("http_503")).toMatch(/did not answer/);
    expect(setupReasonText("meta_190")).toMatch(/Reconnect/);
    expect(setupReasonText("meta_10")).toMatch(/refused the setup/);
  });
});
