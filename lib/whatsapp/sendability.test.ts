import { describe, expect, it } from "vitest";
import { numberSendBlocker } from "./sendability";
import type { WhatsAppAccount, WhatsAppNumber } from "./types";

// D-M3: whether a conversation's business number can send, read from the account list with the
// server's sender checks; anything the list does not settle leaves the reply box in place.

const PHONE = "200000000000001";

function number(overrides: Partial<WhatsAppNumber> = {}): WhatsAppNumber {
  return {
    id: "n1",
    phoneNumberId: PHONE,
    displayPhoneNumber: "+1 555-000-0001",
    status: "active",
    registered: true,
    businessApp: false,
    ...overrides,
  };
}

function account(
  overrides: Partial<WhatsAppAccount> = {},
  numbers: WhatsAppNumber[] = [number()],
): WhatsAppAccount {
  return {
    id: "a1",
    connectionId: "c1",
    wabaId: "100000000000001",
    onboardingType: "cloud_api",
    status: "active",
    setupStatus: "connected",
    connectedAt: "2026-10-01T10:00:00.000Z",
    numbers,
    ...overrides,
  };
}

describe("numberSendBlocker", () => {
  it("lets a registered number of a connected account send", () => {
    expect(numberSendBlocker([account()], PHONE)).toBeUndefined();
    // Setup steps the server does not check (subscribe, imports) do not stop a send.
    expect(
      numberSendBlocker([account({ setupStatus: "action_required", nextStep: "import" })], PHONE),
    ).toBeUndefined();
  });

  it.each([
    ["the number is disconnected", account({}, [number({ status: "disconnected" })])],
    ["the account is disconnected", account({ status: "disconnected" })],
    ["the account's setup says disconnected", account({ setupStatus: "disconnected" })],
  ])("says number_unavailable when %s", (_case, acct) => {
    expect(numberSendBlocker([acct], PHONE)).toBe("number_unavailable");
  });

  it("asks for a reconnect when Meta no longer accepts the connection", () => {
    expect(numberSendBlocker([account({ setupStatus: "reauthorization_required" })], PHONE)).toBe(
      "reconnect_required",
    );
  });

  it("says the number is not ready before Meta registered it", () => {
    expect(numberSendBlocker([account({}, [number({ registered: false })])], PHONE)).toBe(
      "number_not_ready",
    );
  });

  it("leaves the decision to the server when the list does not settle it", () => {
    // Not in the list (no accounts yet, another number, or a number set up by support).
    expect(numberSendBlocker([], PHONE)).toBeUndefined();
    expect(numberSendBlocker([account({}, [number({ phoneNumberId: "other" })])], PHONE)).toBe(
      undefined,
    );
    // An older, disconnected account still lists the number, but the current one can send.
    expect(
      numberSendBlocker(
        [account({ id: "old", status: "disconnected" }), account({ id: "new" })],
        PHONE,
      ),
    ).toBeUndefined();
  });
});
