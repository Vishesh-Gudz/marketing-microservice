import { PROVIDERS, type AdConnectionProvider } from "./providers";
import type {
  AccountStatus,
  ConnectionStatus,
  DiscoveredAsset,
  ManagerStatus,
  TestAccountStatus,
} from "./types";

/**
 * UI-only mirror of the server's link rules (convex/connections/assets.ts linkAdAccounts):
 * only a discovered, not-yet-linked account that the platform CONFIRMED as a client, on an
 * active connection, is offered for selection. The server re-checks every rule; this only
 * decides what the UI offers and never authorizes anything. The test-account status is
 * informational: it never blocks selection (the server does not check it either).
 */

export type LinkBlock =
  "connection_inactive" | "already_linked" | "manager" | "manager_status_unknown";

export type Linkability = { selectable: true } | { selectable: false; blockedBy: LinkBlock };

export function assetLinkability(
  asset: Pick<DiscoveredAsset, "linked" | "isManager" | "managerStatus">,
  connectionStatus: ConnectionStatus,
): Linkability {
  if (connectionStatus !== "active") return { selectable: false, blockedBy: "connection_inactive" };
  if (asset.linked) return { selectable: false, blockedBy: "already_linked" };
  if (asset.isManager || asset.managerStatus === "manager")
    return { selectable: false, blockedBy: "manager" };
  if (asset.managerStatus !== "client")
    return { selectable: false, blockedBy: "manager_status_unknown" };
  return { selectable: true };
}

/** Why an account cannot be selected, in the provider's words. */
export function linkBlockMessage(block: LinkBlock, provider: AdConnectionProvider): string {
  const { name, platform } = PROVIDERS[provider];
  switch (block) {
    case "connection_inactive":
      return `Reconnect ${name} before linking accounts.`;
    case "already_linked":
      return "Already linked.";
    case "manager":
      return "Manager accounts cannot be linked. Link one of its client accounts instead.";
    case "manager_status_unknown":
      return `${platform} did not report whether this is a client account. Retry discovery to check again.`;
  }
}

const MANAGER_LABELS: Readonly<Record<ManagerStatus, string>> = {
  manager: "Manager account",
  client: "Client account",
  unknown: "Account type not reported",
};

export function managerStatusLabel(status: ManagerStatus): string {
  return MANAGER_LABELS[status];
}

const TEST_LABELS: Readonly<Record<TestAccountStatus, { label: string; hint: string }>> = {
  test: {
    label: "Test account",
    hint: "Test accounts do not serve real ads, so reports may stay empty.",
  },
  not_test: {
    label: "Not a test account",
    hint: "Syncing it needs Explorer access or higher for this service's Google Cloud project.",
  },
  unknown: {
    label: "Test status not reported",
    hint: "Google did not report whether this is a test account.",
  },
};

export function testAccountLabel(status: TestAccountStatus): { label: string; hint: string } {
  return TEST_LABELS[status];
}

const ACCOUNT_STATUS_LABELS: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  disabled: "Disabled",
  closed: "Closed",
  pending: "Pending",
  unknown: "Status not reported",
};

export function accountStatusLabel(status: AccountStatus): string {
  return ACCOUNT_STATUS_LABELS[status];
}
