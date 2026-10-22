import { isClerkPublishableKey, resolveAuthMode } from "./mode";

// Build-time values: Next.js inlines the literal process.env.NEXT_PUBLIC_* / NODE_ENV
// references below. The NODE_ENV guard means production bundles never even contain the
// dev token string.
export const DEV_AUTH_TOKEN =
  process.env.NODE_ENV === "production" ? undefined : process.env.NEXT_PUBLIC_DEV_AUTH_TOKEN;

export const AUTH_MODE = resolveAuthMode(process.env.NODE_ENV, DEV_AUTH_TOKEN);

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/** The Clerk publishable key when Clerk is the active, configured identity; else undefined. */
export const CLERK_PUBLISHABLE_KEY =
  AUTH_MODE === "clerk" && isClerkPublishableKey(publishableKey) ? publishableKey : undefined;

export const CLERK_ENABLED = CLERK_PUBLISHABLE_KEY !== undefined;
