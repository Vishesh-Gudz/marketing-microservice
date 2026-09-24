import type { AdPlatform } from "../../domain/types";
import type { AdsProviderCapabilities } from "../capabilities";
import type {
  ProviderActionRow,
  ProviderAd,
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
} from "../types";
import type { LeafGenerator, LeafSpec, NeutralRow } from "./generator";

/**
 * A raw platform-shaped item plus its normalizer. Entity lists are paged in
 * RAW form and only the requested page is normalized, like a real provider.
 */
export type RawEntry<T> = {
  /** Stable sort key (raw platform id). */
  sortKey: string;
  /** Raw "last updated" instant, when the platform reports one (drives updatedSince). */
  updatedAt?: number;
  normalize(): T;
};

export type MockAccountInfo = {
  externalId: string;
  currency: string;
  timezone: string;
  isManager: boolean;
};

/** Everything that differs between the Meta-like and Google-like mock. */
export type MockFlavor = {
  platform: AdPlatform;
  capabilities: AdsProviderCapabilities;
  /** Account that fails in the permission_denied scenario. */
  deniedAccountExternalId: string;
  accounts(): RawEntry<ProviderAdAccount>[];
  accountInfo(externalId: string): MockAccountInfo | undefined;
  campaigns(accountExternalId: string, malformed: boolean): RawEntry<ProviderCampaign>[];
  adGroups(accountExternalId: string, malformed: boolean): RawEntry<ProviderAdGroup>[];
  ads(accountExternalId: string): RawEntry<ProviderAd>[];
  creatives(accountExternalId: string): RawEntry<ProviderCreative>[];
  leaves(accountExternalId: string): LeafSpec[];
  generator(accountExternalId: string): LeafGenerator;
  /** Formats neutral rows as raw platform payloads and normalizes them back. */
  metricRows(account: MockAccountInfo, rows: NeutralRow[]): ProviderMetricRow[];
  actionRows(account: MockAccountInfo, rows: NeutralRow[]): ProviderActionRow[];
};

/** Drops undefined-valued keys (records omit absent fields; they never carry undefined). */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Parses a platform integer-count string ("1234"). */
export function toCount(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid count "${value}"`);
  return n;
}

export function bySortKey<T>(entries: RawEntry<T>[]): RawEntry<T>[] {
  return [...entries].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}
