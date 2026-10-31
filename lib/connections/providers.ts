import { formatCustomerId } from "./customer-id";

/**
 * The platforms the Connections page manages: the ad platforms (ADR 0008, D17 amendment),
 * YouTube organic (ADR 0016, Checkpoint 5) and Instagram for direct messages (ADR 0017; the
 * connect itself goes through Meta's Unified Login when the backend is configured for it).
 * Each provider's wording and display rules live here so the shared card never shows one
 * platform's wording for another.
 */
export const AD_CONNECTION_PROVIDERS = ["google_ads", "meta"] as const;
export type AdConnectionProvider = (typeof AD_CONNECTION_PROVIDERS)[number];

export function isAdConnectionProvider(value: unknown): value is AdConnectionProvider {
  return (AD_CONNECTION_PROVIDERS as readonly unknown[]).includes(value);
}

/** Every provider the Connections page offers: the ad platforms, then YouTube and Instagram. */
export const CONNECTION_PROVIDERS = [...AD_CONNECTION_PROVIDERS, "youtube", "instagram"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export function isConnectionProvider(value: unknown): value is ConnectionProvider {
  return (CONNECTION_PROVIDERS as readonly unknown[]).includes(value);
}

export type ProviderInfo = {
  /** Product name: "Google Ads", "Meta Ads". */
  name: string;
  /** The company whose sign-in page the user sees: "Google", "Meta". */
  platform: string;
  /** The account the user signs in with: "Google account", "Facebook account". */
  identity: string;
  /** What one account is called in sentences: "Google Ads account", "YouTube channel". */
  accountNoun: string;
  /** Display form of an ad account id (display only; never parsed back). */
  formatAccountId(id: string): string;
  /** Whether discovery reports the account type and test status (Google does; Meta does not). */
  reportsAccountType: boolean;
  /** Column for the account a discovered account was found through. */
  parentLabel: string;
  /** Shown when an account has no such parent. */
  noParent: string;
};

export const PROVIDERS: Readonly<Record<ConnectionProvider, ProviderInfo>> = {
  google_ads: {
    name: "Google Ads",
    platform: "Google",
    identity: "Google account",
    accountNoun: "Google Ads account",
    formatAccountId: formatCustomerId,
    reportsAccountType: true,
    parentLabel: "Manager",
    noParent: "Direct access",
  },
  meta: {
    name: "Meta Ads",
    platform: "Meta",
    identity: "Facebook account",
    accountNoun: "Meta ad account",
    // Meta ad account ids are shown as Meta shows them (digits, without "act_").
    formatAccountId: (id) => id,
    reportsAccountType: false,
    parentLabel: "Business",
    noParent: "—",
  },
  // ADR 0016: YouTube's own Google OAuth client; one consent = one channel (shown by its id).
  youtube: {
    name: "YouTube",
    platform: "Google",
    identity: "Google account",
    accountNoun: "YouTube channel",
    formatAccountId: (id) => id,
    reportsAccountType: false,
    parentLabel: "—",
    noParent: "—",
  },
  // ADR 0017: one connection = one Instagram professional account (shown by its id), signed in
  // through Meta.
  instagram: {
    name: "Instagram",
    platform: "Meta",
    identity: "Instagram account",
    accountNoun: "Instagram account",
    formatAccountId: (id) => id,
    reportsAccountType: false,
    parentLabel: "—",
    noParent: "—",
  },
};
