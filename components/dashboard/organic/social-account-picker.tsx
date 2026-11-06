"use client";

import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { humanize } from "@/lib/analytics/labels";
import type { SocialAccount } from "@/lib/analytics/organic-types";

export function socialAccountLabel(account: SocialAccount): string {
  const name = account.username !== undefined ? `@${account.username}` : account.name;
  return `${name} · ${humanize(account.accountType)}${account.linked ? "" : " · unlinked"}`;
}

/**
 * The single account the organic dashboard shows (keyboard-operable Select): an Instagram
 * account, or a YouTube channel in the YouTube view. The selection lives in the URL
 * (`account`); the list comes from v1/socialAccounts:list.
 */
export function SocialAccountPicker({
  accounts,
  selectedId,
  onSelect,
  truncated = false,
  label = "Instagram account",
  prefix = "Account",
}: {
  accounts: readonly SocialAccount[];
  selectedId: string | undefined;
  onSelect: (accountId: string) => void;
  /** The org has more accounts than the first page lists. */
  truncated?: boolean;
  /** The accessible name. */
  label?: string;
  /** The short label shown inside the control, like the filter bar. */
  prefix?: string;
}) {
  const id = useId();
  const known = accounts.some((account) => account.id === selectedId);
  return (
    <div className="grid min-w-0 gap-1" data-testid="social-account-picker">
      <span id={`${id}-label`} className="sr-only">
        {label}
      </span>
      <Select value={known ? selectedId : undefined} onValueChange={onSelect}>
        <SelectTrigger
          size="sm"
          className="w-full min-w-0 justify-start sm:w-auto sm:min-w-64 [&>svg:last-child]:ml-auto"
          aria-labelledby={`${id}-label`}
        >
          <span aria-hidden="true" className="text-muted-foreground">
            {prefix}
          </span>
          <SelectValue placeholder="Choose an account" />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {socialAccountLabel(account)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {truncated && (
        <p className="text-xs text-muted-foreground">Showing the first 100 accounts.</p>
      )}
    </div>
  );
}
