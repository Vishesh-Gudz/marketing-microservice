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
}: {
  accounts: readonly SocialAccount[];
  selectedId: string | undefined;
  onSelect: (accountId: string) => void;
  /** The org has more accounts than the first page lists. */
  truncated?: boolean;
  label?: string;
}) {
  const id = useId();
  const known = accounts.some((account) => account.id === selectedId);
  return (
    <div className="grid gap-1" data-testid="social-account-picker">
      <span id={`${id}-label`} className="text-xs font-medium">
        {label}
      </span>
      <Select value={known ? selectedId : undefined} onValueChange={onSelect}>
        <SelectTrigger size="sm" className="w-72 max-w-full" aria-labelledby={`${id}-label`}>
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
