import { describe, expect, it } from "vitest";
import { MAX_FUTURE_SKEW_MS, SERVICE_WINDOW_MS } from "./config";
import { applyDeliveryStatus, type DeliveryState } from "./status";
import { effectiveInboundAt, isServiceWindowOpen, serviceWindowExpiresAt } from "./window";

function run(start: DeliveryState, reports: Parameters<typeof applyDeliveryStatus>[1][]) {
  let state = start;
  for (const report of reports) {
    const patch = applyDeliveryStatus(state, report);
    if (patch !== null) state = { ...state, ...patch };
  }
  return state;
}

describe("applyDeliveryStatus", () => {
  it("moves forward through sent, delivered and read with each timestamp", () => {
    expect(
      run({ status: "submitted" }, [
        { status: "sent", timestampMs: 1 },
        { status: "delivered", timestampMs: 2 },
        { status: "read", timestampMs: 3 },
      ]),
    ).toEqual({ status: "read", sentAt: 1, deliveredAt: 2, readAt: 3 });
  });

  it("never moves backwards on out-of-order reports, but records their timestamps", () => {
    expect(
      run({ status: "submitted" }, [
        { status: "read", timestampMs: 3 },
        { status: "delivered", timestampMs: 2 },
        { status: "sent", timestampMs: 1 },
      ]),
    ).toEqual({ status: "read", sentAt: 1, deliveredAt: 2, readAt: 3 });
  });

  it("never changes inbound or unknown messages (an unknown send has no wamid to report on)", () => {
    for (const status of ["received", "unknown"] as const) {
      for (const report of ["sent", "delivered", "read", "failed"] as const) {
        expect(applyDeliveryStatus({ status }, { status: report, timestampMs: 1 })).toBeNull();
      }
    }
  });

  it("keeps the first timestamp of a repeated report and reports no change", () => {
    const state: DeliveryState = { status: "delivered", deliveredAt: 2 };
    expect(applyDeliveryStatus(state, { status: "delivered", timestampMs: 9 })).toBeNull();
  });

  it("fails before delivery with the error code, and stays failed", () => {
    expect(
      run({ status: "submitted" }, [
        { status: "sent", timestampMs: 1 },
        { status: "failed", timestampMs: 2, errorCode: 131026 },
        { status: "delivered", timestampMs: 3 },
        { status: "read", timestampMs: 4 },
      ]),
    ).toEqual({
      status: "failed",
      errorCode: 131026,
      sentAt: 1,
      failedAt: 2,
      deliveredAt: 3,
      readAt: 4,
    });
  });

  it("does not let a late failure override a delivered or read message", () => {
    expect(run({ status: "read" }, [{ status: "failed", timestampMs: 5, errorCode: 1 }])).toEqual({
      status: "read",
      failedAt: 5,
    });
  });

  it("never touches inbound messages", () => {
    expect(
      applyDeliveryStatus({ status: "received" }, { status: "read", timestampMs: 1 }),
    ).toBeNull();
  });
});

describe("service window", () => {
  it("is open for 24 hours after the last inbound message", () => {
    const at = 1_000_000;
    expect(serviceWindowExpiresAt(at)).toBe(at + SERVICE_WINDOW_MS);
    expect(isServiceWindowOpen(at, at + SERVICE_WINDOW_MS - 1)).toBe(true);
    expect(isServiceWindowOpen(at, at + SERVICE_WINDOW_MS)).toBe(false);
    expect(isServiceWindowOpen(undefined, at)).toBe(false);
    expect(serviceWindowExpiresAt(undefined)).toBeUndefined();
  });

  it("clamps platform timestamps too far in the future to the receipt time", () => {
    const received = 5_000_000;
    expect(effectiveInboundAt(received - 10, received)).toBe(received - 10);
    expect(effectiveInboundAt(received + MAX_FUTURE_SKEW_MS, received)).toBe(
      received + MAX_FUTURE_SKEW_MS,
    );
    expect(effectiveInboundAt(received + MAX_FUTURE_SKEW_MS + 1, received)).toBe(received);
  });
});
