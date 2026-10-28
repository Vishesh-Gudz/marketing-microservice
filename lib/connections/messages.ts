import { isMarketingError } from "@/convex/lib/errors";
import { describeError } from "@/lib/analytics/errors";
import { PROVIDERS, type AdConnectionProvider, type ConnectionProvider } from "./providers";
import type {
  ConnectionError,
  ConnectionStatus,
  ErrorReason,
  Notice,
  NoticeTone,
  SyncStatus,
} from "./types";

/**
 * Fixed, user-facing text for the connection flow (Google Ads, Meta Ads and YouTube):
 * connection status, discovery failures, sync status and errors from connect / link /
 * refresh / disconnect. Every text names the provider it is for, so a Meta connection never
 * shows Google wording. Only public contract values are inspected (status enums, error kind,
 * the allowlisted `reason`, error code + details); server messages and platform codes are
 * never displayed.
 */

/** Google Ads: one message per allowlisted reason (exhaustive by type; parity-tested). */
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

/**
 * Meta Ads: one message per allowlisted reason (exhaustive by type; parity-tested). Meta
 * errors are mapped by the server from the Graph code and the error kind
 * (docs/providers/meta.md, "Public reasons"); reasons Meta never produces still get a
 * Meta-worded fallback.
 */
export const META_ERROR_REASON_MESSAGES: Readonly<Record<ErrorReason, string>> = {
  cloud_project_not_approved_for_production:
    "This service is not approved to read this Meta ad account yet. Contact an administrator.",
  provider_config_invalid:
    "Meta Ads is not configured correctly on this service. Contact an administrator.",
  provider_mode_misconfigured:
    "This service is not set up to connect to Meta Ads. Contact an administrator.",
  provider_unavailable: "Meta Ads is not available on this service right now.",
  reauth_required: "Meta needs you to sign in again. Reconnect Meta Ads.",
  not_ads_user:
    "This Facebook account has no access to a Meta ad account. Connect with a Facebook account that does.",
  permission_denied:
    "The connected Facebook account has no permission to read this Meta ad account.",
  account_not_enabled: "This Meta ad account is not enabled.",
  account_not_accessible:
    "This Meta ad account does not exist or can no longer be read with the connected Facebook account.",
  account_not_found: "Meta could not find this ad account.",
  rate_limited: "Meta is limiting requests right now. It is retried automatically.",
};

const REASON_MESSAGES: Readonly<
  Record<AdConnectionProvider, Readonly<Record<ErrorReason, string>>>
> = {
  google_ads: ERROR_REASON_MESSAGES,
  meta: META_ERROR_REASON_MESSAGES,
};

function reasonMessage(
  reason: string | undefined,
  provider: ConnectionProvider,
): string | undefined {
  // YouTube has no allowlisted reasons (the reasons are Google Ads / Meta discovery reasons).
  if (provider === "youtube") return undefined;
  const messages = REASON_MESSAGES[provider];
  return reason !== undefined && Object.prototype.hasOwnProperty.call(messages, reason)
    ? messages[reason as ErrorReason]
    : undefined;
}

/** The connection's own state (the discovery error is described separately). */
export function connectionStatusNotice(
  connection: {
    status: ConnectionStatus;
    missingScopes: readonly string[];
    expiresSoon: boolean;
  },
  provider: ConnectionProvider,
): Notice {
  const { name, platform, identity } = PROVIDERS[provider];
  switch (connection.status) {
    case "revoked":
      return {
        tone: "error",
        title: "Disconnected",
        message: `This ${name} connection was disconnected. Connect again to resume syncing.`,
      };
    case "needs_reauth":
      return {
        tone: "warning",
        title: "Reconnect required",
        message: `${platform} access expired or was revoked. Reconnect with the same ${identity}, or disconnect ${name} to use a different one.`,
      };
    case "active":
      if (connection.missingScopes.length > 0 && provider === "youtube") {
        // yt-analytics.readonly is the only YouTube scope a connection can lack (ADR 0016).
        return {
          tone: "warning",
          title: "YouTube Analytics access is missing",
          message:
            "Daily channel metrics cannot sync. Reconnect YouTube and allow access to YouTube Analytics when Google asks.",
        };
      }
      if (connection.missingScopes.length > 0) {
        return {
          tone: "warning",
          title: `${name} access is missing`,
          message: `Reconnect and allow access to ${name} when ${platform} asks.`,
        };
      }
      if (connection.expiresSoon) {
        return {
          tone: "info",
          title: "Access expires soon",
          message: `Reconnect ${name} soon to keep syncing.`,
        };
      }
      return { tone: "success", title: "Connected", message: `${name} is connected.` };
  }
}

/** Why account discovery failed; `null` when the connection has no recorded error. */
export function discoveryErrorNotice(
  error: ConnectionError | undefined,
  provider: ConnectionProvider,
): Notice | null {
  if (error === undefined) return null;
  const { name, accountNoun } = PROVIDERS[provider];
  const title = `Your ${accountNoun}s could not be loaded`;
  const specific = reasonMessage(error.reason, provider);
  if (specific !== undefined) return { tone: "error", title, message: specific };
  switch (error.kind) {
    case "auth":
      return {
        tone: "error",
        title,
        message:
          provider === "youtube"
            ? "Google needs you to sign in again. Reconnect YouTube."
            : REASON_MESSAGES[provider].reauth_required,
      };
    case "rate_limited":
    case "transient":
      return {
        tone: "warning",
        title,
        message: `${name} did not respond. Retry discovery in a few minutes.`,
      };
    default:
      return {
        tone: "error",
        title,
        message: `Retry discovery. If it keeps failing, reconnect ${name}.`,
      };
  }
}

export type SyncSummary = { tone: NoticeTone; label: string; detail?: string };

const RETRIED = "It is retried automatically.";

/** One line for a linked account's sync status (`undefined`: no sync state yet). */
export function syncStatusSummary(
  sync: SyncStatus | undefined,
  provider: AdConnectionProvider,
): SyncSummary {
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
          reasonMessage(sync.lastError?.reason, provider) ??
          `${PROVIDERS[provider].platform} denied access to this account or it no longer exists. It is checked again every 24 hours.`,
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
          reasonMessage(sync.lastError?.reason, provider) ??
          `Some data could not be loaded. ${RETRIED}`,
      };
    case "failed": {
      const streak =
        sync.consecutiveFailures > 1 ? ` (${sync.consecutiveFailures} failures in a row)` : "";
      return {
        tone: "warning",
        label: `Last sync failed${streak}`,
        detail: reasonMessage(sync.lastError?.reason, provider) ?? RETRIED,
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
export function connectionActionNotice(error: unknown, provider: ConnectionProvider): Notice {
  const { name, platform } = PROVIDERS[provider];
  if (isMarketingError(error)) {
    const { code, details } = error.data;
    switch (code) {
      case "INVALID_ARGUMENT":
        if (details?.field === "returnUrl") {
          return {
            tone: "error",
            title: "This dashboard address is not allowed",
            message: `${platform} sign-in cannot return to this address. An administrator must add it to the app's allowed return URLs.`,
          };
        }
        if (details?.field === "provider") {
          return {
            tone: "error",
            title: `${name} is not available`,
            message: `${name} cannot be connected on this service yet.`,
          };
        }
        if (details?.reason === "manager_status_unknown") {
          return {
            tone: "error",
            title: "Account type not confirmed",
            message: `${platform} did not confirm this is a client account. Retry discovery, then try again.`,
          };
        }
        return {
          tone: "error",
          title: "This account cannot be linked",
          message:
            provider === "meta"
              ? "Choose an ad account from the discovered list."
              : provider === "youtube"
                ? "Choose the channel from the discovered list."
                : "Choose a client account from the discovered list.",
        };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Not found",
          message: "This connection or account is not available. Retry discovery and try again.",
        };
      case "CONFLICT":
        if (details?.reason === "purge_pending") {
          return {
            tone: "warning",
            title: "Stored data is still being deleted",
            message:
              "This channel's stored YouTube data is still being deleted. Try again in a few minutes.",
          };
        }
        return details?.reason === "connection_inactive"
          ? {
              tone: "error",
              title: "Connection not active",
              message: `Reconnect ${name}, then try again.`,
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
          message: `Only organization admins can connect ${name} or link accounts.`,
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
          title: `${name} did not respond`,
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

/** Shown after an admin disconnected the provider. */
export function disconnectedNotice(provider: AdConnectionProvider): Notice {
  const { name, identity } = PROVIDERS[provider];
  return {
    tone: "success",
    title: `${name} disconnected`,
    message: `Linked accounts stopped syncing; their data and history are kept. Connect ${name} to sign in with any ${identity}.`,
  };
}

/** Errors of disconnect: fixed text, never the server message. */
export function disconnectActionNotice(error: unknown, provider: ConnectionProvider): Notice {
  const { name } = PROVIDERS[provider];
  if (!isMarketingError(error)) {
    return {
      tone: "error",
      title: "Something went wrong",
      message: `${name} was not disconnected. Try again.`,
    };
  }
  switch (error.data.code) {
    case "FORBIDDEN":
      return {
        tone: "error",
        title: "Admins only",
        message: `Only organization admins can disconnect ${name}.`,
      };
    case "NOT_FOUND":
      return {
        tone: "error",
        title: "Connection not found",
        message: `This ${name} connection no longer exists. Reload the page.`,
      };
    default:
      return connectionActionNotice(error, provider);
  }
}
