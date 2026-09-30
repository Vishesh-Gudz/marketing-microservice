import { isMarketingError } from "@/convex/lib/errors";

/**
 * Maps a failed query to what the dashboard shows (D15). Only the public
 * error contract (code + details) is inspected; messages from unexpected
 * server errors are never displayed.
 */

export type DashboardErrorKind =
  | "too_many_rows"
  | "not_found"
  | "invalid_argument"
  | "unauthenticated"
  | "forbidden"
  | "org_not_provisioned"
  | "unknown";

export type DashboardError = {
  kind: DashboardErrorKind;
  title: string;
  message: string;
  /** A retry can help (transient or unknown failures). */
  retryable: boolean;
};

/** Contract `details.field` values (docs/analytics.md) in plain words. */
const FIELD_LABEL: Record<string, string> = {
  range: "date range",
  compare: "comparison period",
  filters: "filters",
  "filters.accountIds": "account filters",
  parent: "parent selection",
  level: "level",
  "paginationOpts.cursor": "page position",
};

export function describeError(error: unknown): DashboardError {
  if (!isMarketingError(error)) {
    return {
      kind: "unknown",
      title: "Something went wrong",
      message: "The data could not be loaded. Try again.",
      retryable: true,
    };
  }
  const { code, details } = error.data;
  switch (code) {
    case "INVALID_ARGUMENT":
      if (details?.reason === "too_many_rows") {
        return {
          kind: "too_many_rows",
          title: "Too much data for one view",
          message: "This view covers too much data. Narrow the date range or filter accounts.",
          retryable: false,
        };
      }
      return {
        kind: "invalid_argument",
        title: "Invalid filters",
        message: `Check the ${FIELD_LABEL[String(details?.field ?? "")] ?? "filters"}: the current value is not accepted.`,
        retryable: false,
      };
    case "NOT_FOUND":
      return {
        kind: "not_found",
        title: "Not found",
        message: "This item does not exist or is not available to your organization.",
        retryable: false,
      };
    case "UNAUTHENTICATED":
    case "INVALID_TOKEN_CLAIMS":
    case "APP_NOT_REGISTERED":
    case "APP_DISABLED":
      return {
        kind: "unauthenticated",
        title: "Sign-in required",
        message:
          "Your session is missing or no longer valid. Open the dashboard from your app again.",
        retryable: false,
      };
    case "FORBIDDEN":
      return {
        kind: "forbidden",
        title: "Not allowed",
        message: "Your role does not allow this view.",
        retryable: false,
      };
    case "ORG_NOT_PROVISIONED":
      return {
        kind: "org_not_provisioned",
        title: "Organization not ready",
        message: "Your organization is being set up. Try again in a moment.",
        retryable: true,
      };
    default:
      return {
        kind: "unknown",
        title: "Something went wrong",
        message: "The data could not be loaded. Try again.",
        retryable: true,
      };
  }
}
