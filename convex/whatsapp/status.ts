import type { DeliveryStatus } from "./payload";
import type { MessageStatus } from "./validators";

/**
 * Delivery-status state machine for outbound messages (pure).
 *
 * Meta does not guarantee webhook order: `read` can arrive before `delivered`, and retried
 * deliveries repeat old statuses. Statuses therefore only move a message FORWARD:
 *
 *   pending < submitted < sent < delivered < read          failed (terminal)
 *
 * - A lower or equal status never replaces a higher one, but its timestamp is still recorded
 *   once (a late `delivered` after `read` sets `deliveredAt`).
 * - `failed` applies only before delivery (pending / submitted / sent) and is terminal: later
 *   `sent` / `delivered` / `read` reports do not revive the message.
 * - The first report of each status wins; repeats change nothing.
 */

const RANK: Readonly<Record<Exclude<MessageStatus, "received" | "failed">, number>> = {
  pending: 0,
  submitted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

const TIMESTAMP_FIELD = {
  sent: "sentAt",
  delivered: "deliveredAt",
  read: "readAt",
  failed: "failedAt",
} as const satisfies Record<DeliveryStatus, string>;

export type DeliveryState = {
  status: MessageStatus;
  errorCode?: number;
  sentAt?: number;
  deliveredAt?: number;
  readAt?: number;
  failedAt?: number;
};

export type DeliveryPatch = Partial<DeliveryState>;

/** The changes a status report makes to an outbound message, or null when it changes nothing. */
export function applyDeliveryStatus(
  current: DeliveryState,
  report: { status: DeliveryStatus; timestampMs: number; errorCode?: number },
): DeliveryPatch | null {
  if (current.status === "received") return null;
  const patch: DeliveryPatch = {};
  const field = TIMESTAMP_FIELD[report.status];
  if (current[field] === undefined) patch[field] = report.timestampMs;

  if (current.status !== "failed") {
    if (report.status === "failed") {
      if (RANK[current.status] < RANK.delivered) {
        patch.status = "failed";
        if (report.errorCode !== undefined) patch.errorCode = report.errorCode;
      }
    } else if (RANK[report.status] > RANK[current.status]) {
      patch.status = report.status;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
