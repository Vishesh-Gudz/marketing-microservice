import type { WhatsAppAccount, WhatsAppNumber } from "./types";

// D-M3 (Kinso K3): a WhatsApp conversation shows "Replies unavailable" instead of a reply box
// when its business number cannot send. The conversation's own record does not say so, so this
// reads the org's accounts (v1/whatsapp:listAccounts) and applies the same checks as the server's
// sender lookup (convex/whatsapp/outbound.ts `senderOf`), in the same order. It only ever hides
// the reply box when the list settles it: a number it cannot find, or one of several matching
// rows that could send, leaves the reply box in place, and the send endpoint decides as before.

/** The reasons the server gives for refusing a send from the number (`details.reason`). */
export type NumberSendBlocker = "number_unavailable" | "reconnect_required" | "number_not_ready";

function blockerOf(
  account: WhatsAppAccount,
  number: WhatsAppNumber,
): NumberSendBlocker | undefined {
  if (number.status !== "active" || account.status !== "active") return "number_unavailable";
  if (account.setupStatus === "disconnected") return "number_unavailable";
  if (account.setupStatus === "reauthorization_required") return "reconnect_required";
  if (!number.registered) return "number_not_ready";
  return undefined;
}

/**
 * Why the business number with this Meta `phoneNumberId` cannot send, or undefined when it can
 * or when the accounts do not settle it.
 */
export function numberSendBlocker(
  accounts: readonly WhatsAppAccount[],
  phoneNumberId: string,
): NumberSendBlocker | undefined {
  let first: NumberSendBlocker | undefined;
  for (const account of accounts) {
    for (const number of account.numbers) {
      if (number.phoneNumberId !== phoneNumberId) continue;
      const blocker = blockerOf(account, number);
      if (blocker === undefined) return undefined;
      first ??= blocker;
    }
  }
  return first;
}
