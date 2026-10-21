import { isMarketingError } from "@/convex/lib/errors";
import { describeError } from "@/lib/analytics/errors";
import type {
  ConnectionError,
  ConnectionStatus,
  ErrorReason,
  Notice,
  NoticeTone,
  SyncStatus,
} from "./types";

/**
 * Fixed, user-facing text for the Google Ads connection flow: connection status, discovery
 * failures, sync status and errors from connect / link / refresh. Only public contract
 * values are inspected (status enums, error kind, the allowlisted `reason`, error code +
 * details); server messages and platform codes are never displayed.
 */

/** One message per allowlisted reason (exhaustive by type; parity-tested in tests/unit). */
export const ERROR_REASON_MESSAGES: Readonly<Record<ErrorReason, string>> = {
  cloud_project_not_approved_for_production:
    "This service's Google Cloud project has Test access only, so it can read Google Ads test accounts only. An administrator must request Explorer access or higher.",
  provider_config_invalid:
    "Google Ads is not configured correctly on this service. Contact an administrator.",
  provider_mode_misconfigured:
    "This service is not set up to connect to Google Ads. Contact an administrator.",
  provider_unavailable: "Google Ads is not available on this service right now.",
  reauth_required: "Google needs you to sign in again. Reconnect Google Ads.",
  not_ads_user:
    "This Google account has no access to a Google Ads account. Connect with a Google account that does.",
  permission_denied: "The connected Google account has no permission to read this account.",
  account_not_enabled: "This Google Ads account is not enabled (for example, it was cancelled).",
  account_not_accessible:
    "This Google Ads account is no longer reachable through the connected Google account.",
  account_not_found: "Google Ads could not find this account.",
  rate_limited: "Google Ads is limiting requests right now. It is retried automatically.",
};

function reasonMessage(reason: string | undefined): string | undefined {
  return reason !== undefined && Object.prototype.hasOwnProperty.call(ERROR_REASON_MESSAGES, reason)
    ? ERROR_REASON_MESSAGES[reason as ErrorReason]
    : undefined;
}

/** The connection's own state (the discovery error is described separately). */
export function connectionStatusNotice(connection: {
  status: ConnectionStatus;
  missingScopes: readonly string[];
  expiresSoon: boolean;
}): Notice {
  switch (connection.status) {
    case "revoked":
      return {
        tone: "error",
        title: "Disconnected",
        message: "This Google Ads connection was disconnected. Connect again to resume syncing.",
      };
    case "needs_reauth":
      return {
        tone: "warning",
        title: "Reconnect required",
        message: "Google access expired or was revoked. Reconnect with the same Google account.",
      };
    case "active":
      if (connection.missingScopes.length > 0) {
        return {
          tone: "warning",
          title: "Google Ads access is missing",
          message: "Reconnect and allow access to Google Ads when Google asks.",
        };
      }
      if (connection.expiresSoon) {
        return {
          tone: "info",
          title: "Access expires soon",
          message: "Reconnect Google Ads soon to keep syncing.",
        };
      }
      return { tone: "success", title: "Connected", message: "Google Ads is connected." };
  }
}

/** Why account discovery failed; `null` when the connection has no recorded error. */
export function discoveryErrorNotice(error: ConnectionError | undefined): Notice | null {
  if (error === undefined) return null;
  const title = "Your Google Ads accounts could not be loaded";
  const specific = reasonMessage(error.reason);
  if (specific !== undefined) return { tone: "error", title, message: specific };
  switch (error.kind) {
    case "auth":
      return { tone: "error", title, message: ERROR_REASON_MESSAGES.reauth_required };
    case "rate_limited":
    case "transient":
      return {
        tone: "warning",
        title,
        message: "Google Ads did not respond. Retry discovery in a few minutes.",
      };
    default:
      return {
        tone: "error",
        title,
        message: "Retry discovery. If it keeps failing, reconnect Google Ads.",
      };
  }
}

export type SyncSummary = { tone: NoticeTone; label: string; detail?: string };

const RETRIED = "It is retried automatically.";

/** One line for a linked account's sync status (`undefined`: no sync state yet). */
export function syncStatusSummary(sync: SyncStatus | undefined): SyncSummary {
  if (sync === undefined) {
    return {
      tone: "info",
      label: "First sync scheduled",
      detail: "Syncing starts automatically shortly after linking.",
    };
  }
  switch (sync.syncState) {
    case "parked":
      return { tone: "info", label: "Not syncing", detail: "This account is not linked." };
    case "blocked":
      return {
        tone: "error",
        label: "Sync blocked",
        detail:
          reasonMessage(sync.lastError?.reason) ??
          "Google denied access to this account or it no longer exists. It is checked again every 24 hours.",
      };
    case "running":
      return { tone: "info", label: "Syncing…" };
    case "idle":
      break;
  }
  const through = sync.coveredThrough !== undefined ? `Data through ${sync.coveredThrough}.` : "";
  switch (sync.lastRunStatus) {
    case undefined:
      return sync.lastSuccessAt !== undefined
        ? { tone: "success", label: "Up to date", ...(through ? { detail: through } : {}) }
        : {
            tone: "info",
            label: "First sync scheduled",
            detail: "Syncing starts automatically shortly after linking.",
          };
    case "queued":
    case "running":
      return { tone: "info", label: "Syncing…" };
    case "succeeded":
      return { tone: "success", label: "Up to date", ...(through ? { detail: through } : {}) };
    case "partial":
      return {
        tone: "warning",
        label: "Last sync partly completed",
        detail:
          reasonMessage(sync.lastError?.reason) ?? `Some data could not be loaded. ${RETRIED}`,
      };
    case "failed": {
      const streak =
        sync.consecutiveFailures > 1 ? ` (${sync.consecutiveFailures} failures in a row)` : "";
      return {
        tone: "warning",
        label: `Last sync failed${streak}`,
        detail: reasonMessage(sync.lastError?.reason) ?? RETRIED,
      };
    }
    case "cancelled":
      return {
        tone: "info",
        label: "Last sync was cancelled",
        detail: "The next sync runs automatically.",
      };
  }
}

/** Errors of beginConnect / listDiscoveredAssets / linkAdAccounts / refreshAssets. */
export function connectionActionNotice(error: unknown): Notice {
  if (isMarketingError(error)) {
    const { code, details } = error.data;
    switch (code) {
      case "INVALID_ARGUMENT":
        if (details?.field === "returnUrl") {
          return {
            tone: "error",
            title: "This dashboard address is not allowed",
            message:
              "Google sign-in cannot return to this address. An administrator must add it to the app's allowed return URLs.",
          };
        }
        if (details?.field === "provider") {
          return {
            tone: "error",
            title: "Google Ads is not available",
            message: "Google Ads cannot be connected on this service yet.",
          };
        }
        if (details?.reason === "manager_status_unknown") {
          return {
            tone: "error",
            title: "Account type not confirmed",
            message:
              "Google did not confirm this is a client account. Retry discovery, then try again.",
          };
        }
        return {
          tone: "error",
          title: "This account cannot be linked",
          message: "Choose a client account from the discovered list.",
        };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Not found",
          message: "This connection or account is not available. Retry discovery and try again.",
        };
      case "CONFLICT":
        return details?.reason === "connection_inactive"
          ? {
              tone: "error",
              title: "Connection not active",
              message: "Reconnect Google Ads, then try again.",
            }
          : {
              tone: "error",
              title: "Conflicting change",
              message: "Something changed in the meantime. Reload the page and try again.",
            };
      case "RATE_LIMITED":
        return {
          tone: "warning",
          title: "Too many attempts",
          message:
            "Too many connection attempts are in progress. Wait a few minutes and try again.",
        };
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Admins only",
          message: "Only organization admins can connect Google Ads or link accounts.",
        };
      case "APP_DISABLED":
        return {
          tone: "error",
          title: "Integration disabled",
          message: "This app's integration is disabled. Contact an administrator.",
        };
      case "PROVIDER_ERROR":
        return {
          tone: "error",
          title: "Google Ads did not respond",
          message: "Try again in a few minutes.",
        };
      default:
        break;
    }
    const described = describeError(error);
    if (described.kind === "unauthenticated" || described.kind === "org_not_provisioned") {
      return { tone: "error", title: described.title, message: described.message };
    }
  }
  return {
    tone: "error",
    title: "Something went wrong",
    message: "The request failed. Try again.",
  };
}
