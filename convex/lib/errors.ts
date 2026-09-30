import { ConvexError } from "convex/values";

/**
 * Standard error codes for the public (`v1`) contract. Every expected failure
 * is a `ConvexError<MarketingErrorData>`; Convex forwards `data` unchanged to
 * JS clients and the HTTP API. Unexpected throws surface as a generic server
 * error, so internals never leak.
 */
export const MARKETING_ERROR_CODES = [
  "UNAUTHENTICATED",
  "INVALID_TOKEN_CLAIMS",
  "APP_NOT_REGISTERED",
  "APP_DISABLED",
  "ORG_NOT_PROVISIONED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "CONFLICT",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "INTERNAL",
] as const;

export type MarketingErrorCode = (typeof MARKETING_ERROR_CODES)[number];

export type MarketingErrorDetails = Record<string, string | number | boolean>;

export type MarketingErrorData = {
  code: MarketingErrorCode;
  message: string;
  details?: MarketingErrorDetails;
};

export function apiError(
  code: MarketingErrorCode,
  message: string,
  details?: MarketingErrorDetails,
): ConvexError<MarketingErrorData> {
  const data: MarketingErrorData = details ? { code, message, details } : { code, message };
  return new ConvexError(data);
}

const CODE_SET: ReadonlySet<string> = new Set(MARKETING_ERROR_CODES);

export function isMarketingErrorData(value: unknown): value is MarketingErrorData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    CODE_SET.has(candidate.code) &&
    typeof candidate.message === "string"
  );
}

export function isMarketingError(error: unknown): error is ConvexError<MarketingErrorData> {
  return error instanceof ConvexError && isMarketingErrorData(error.data);
}
