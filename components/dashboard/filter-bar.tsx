"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/convex/_generated/api";
import { PERIOD_PRESETS, previousPeriod, rangeDays } from "@/convex/analytics/periods";
import { formatRange } from "@/lib/analytics/chart-data";
import {
  MAX_ACCOUNT_FILTER,
  PLATFORMS,
  PRESET_LABELS,
  RANGE_ERROR_TEXT,
  autoGranularity,
  rangeError,
  type DashboardFilters,
  type GranularitySetting,
  type PresetSetting,
} from "@/lib/analytics/filters";
import { humanize } from "@/lib/analytics/labels";
import { useOrg } from "@/lib/analytics/org-context";
import type { AdPlatform } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  useAnalyticsScope,
  useDashboardFilters,
  type DayBasis,
} from "@/lib/analytics/use-dashboard-filters";

type Range = { from: string; to: string };

/** Two native date inputs plus Apply; validated like the API before it is applied. */
function CustomRangeFields({
  legend,
  initial,
  onApply,
}: {
  legend: string;
  initial: Range;
  onApply: (range: Range) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const problem = rangeError(draft);
  return (
    <fieldset className="flex flex-wrap items-end gap-2">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-from`} className="text-xs">
          From
        </Label>
        <Input
          id={`${id}-from`}
          type="date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          className="h-8 w-40"
          aria-invalid={problem !== undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-to`} className="text-xs">
          To
        </Label>
        <Input
          id={`${id}-to`}
          type="date"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          className="h-8 w-40"
          aria-invalid={problem !== undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
        />
      </div>
      <Button size="sm" disabled={problem !== undefined} onClick={() => onApply(draft)}>
        Apply
      </Button>
      {problem && (
        <p id={`${id}-error`} className="w-full text-xs text-destructive" role="alert">
          {RANGE_ERROR_TEXT[problem]}
        </p>
      )}
    </fieldset>
  );
}

function DateRangeControl({
  filters,
  range,
  onChange,
}: {
  filters: DashboardFilters;
  range: Range;
  onChange: (next: DashboardFilters) => void;
}) {
  const [editing, setEditing] = useState(false);
  const custom = filters.preset === "custom" || editing;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <span className="text-xs font-medium" id="date-range-label">
          Date range
        </span>
        <Select
          value={custom ? "custom" : filters.preset}
          onValueChange={(value) => {
            if (value === "custom") {
              setEditing(true);
              return;
            }
            setEditing(false);
            onChange({
              ...filters,
              preset: value as PresetSetting,
              from: undefined,
              to: undefined,
            });
          }}
        >
          <SelectTrigger size="sm" className="w-44" aria-labelledby="date-range-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...PERIOD_PRESETS, "custom" as const].map((preset) => (
              <SelectItem key={preset} value={preset}>
                {PRESET_LABELS[preset]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {custom && (
        <CustomRangeFields
          key={`${range.from}:${range.to}`}
          legend="Custom date range"
          initial={range}
          onApply={(next) => {
            setEditing(false);
            onChange({ ...filters, preset: "custom", from: next.from, to: next.to });
          }}
        />
      )}
    </div>
  );
}

function CompareControl({
  filters,
  range,
  onChange,
}: {
  filters: DashboardFilters;
  range: Range;
  onChange: (next: DashboardFilters) => void;
}) {
  const [editing, setEditing] = useState(false);
  const custom = filters.compare === "custom" || editing;
  const initial =
    filters.compareFrom && filters.compareTo
      ? { from: filters.compareFrom, to: filters.compareTo }
      : previousPeriod(range);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <span className="text-xs font-medium" id="compare-label">
          Compare
        </span>
        <Select
          value={custom ? "custom" : filters.compare}
          onValueChange={(value) => {
            if (value === "custom") {
              setEditing(true);
              return;
            }
            setEditing(false);
            onChange({
              ...filters,
              compare: value as "off" | "previous",
              compareFrom: undefined,
              compareTo: undefined,
            });
          }}
        >
          <SelectTrigger size="sm" className="w-44" aria-labelledby="compare-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="previous">Previous period</SelectItem>
            <SelectItem value="custom">Custom period</SelectItem>
            <SelectItem value="off">No comparison</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {custom && (
        <CustomRangeFields
          key={`${initial.from}:${initial.to}`}
          legend="Comparison period"
          initial={initial}
          onApply={(next) => {
            setEditing(false);
            onChange({ ...filters, compare: "custom", compareFrom: next.from, compareTo: next.to });
          }}
        />
      )}
    </div>
  );
}

function PlatformFilter({
  filters,
  onChange,
}: {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium" id="platform-filter-label">
        Platforms
      </span>
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        role="group"
        aria-labelledby="platform-filter-label"
        value={filters.platforms}
        onValueChange={(value) => onChange({ ...filters, platforms: value as AdPlatform[] })}
      >
        {PLATFORMS.map((platform) => (
          <ToggleGroupItem key={platform} value={platform} className="px-3">
            {humanize(platform)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function AccountFilter({
  filters,
  onChange,
}: {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
}) {
  const id = useId();
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});
  const selectable = (accounts ?? []).filter((a) => !a.isManager);
  const selected = new Set(filters.accounts);
  const label =
    filters.accounts.length === 0
      ? "All accounts"
      : `${filters.accounts.length} ${filters.accounts.length === 1 ? "account" : "accounts"}`;
  const toggle = (accountId: string, checked: boolean) => {
    const next = checked
      ? [...filters.accounts, accountId].slice(0, MAX_ACCOUNT_FILTER)
      : filters.accounts.filter((a) => a !== accountId);
    onChange({ ...filters, accounts: next });
  };
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium" id={`${id}-label`}>
        Accounts
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-44 justify-between"
            aria-labelledby={`${id}-label ${id}-value`}
          >
            <span id={`${id}-value`}>{label}</span>
            <ChevronDown className="size-4 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Filter by ad account</legend>
            {accounts === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
            {accounts !== undefined && selectable.length === 0 && (
              <p className="text-sm text-muted-foreground">No ad accounts yet.</p>
            )}
            <div className="grid max-h-64 gap-2 overflow-y-auto">
              {selectable.map((account) => (
                <div key={account.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-${account.id}`}
                    checked={selected.has(account.id)}
                    onCheckedChange={(checked) => toggle(account.id, checked === true)}
                  />
                  <Label htmlFor={`${id}-${account.id}`} className="font-normal">
                    {account.name}
                    <span className="text-xs text-muted-foreground">
                      {humanize(account.platform)} · {account.currency}
                      {!account.linked ? " · unlinked" : ""}
                    </span>
                  </Label>
                </div>
              ))}
            </div>
            {filters.accounts.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={() => onChange({ ...filters, accounts: [] })}
              >
                Clear selection
              </Button>
            )}
          </fieldset>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const GRANULARITY_OPTIONS: GranularitySetting[] = ["auto", "day", "week", "month"];

function GranularityControl({
  filters,
  range,
  onChange,
}: {
  filters: DashboardFilters;
  range: Range;
  onChange: (next: DashboardFilters) => void;
}) {
  const auto = autoGranularity(rangeDays(range));
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium" id="granularity-label">
        Interval
      </span>
      <Select
        value={filters.granularity}
        onValueChange={(value) =>
          onChange({ ...filters, granularity: value as GranularitySetting })
        }
      >
        <SelectTrigger size="sm" className="w-36" aria-labelledby="granularity-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GRANULARITY_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option === "auto" ? `Auto (${humanize(auto)})` : humanize(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Global filters (D3/D12). Everything is URL state; each view enables only the
 * controls its API query accepts (e.g. entity views take no account filters).
 * `dayBasis="utc"` (organic Instagram) resolves presets against today in UTC and says so;
 * the default ("org") is the paid dashboard's behavior, unchanged.
 */
export function FilterBar({
  accounts = true,
  compare = true,
  granularity = false,
  dayBasis = "org",
}: {
  accounts?: boolean;
  compare?: boolean;
  granularity?: boolean;
  dayBasis?: DayBasis;
}) {
  const org = useOrg();
  const { filters, setFilters } = useDashboardFilters();
  const scope = useAnalyticsScope({ dayBasis });
  const comparison =
    scope.compare === undefined
      ? undefined
      : scope.compare === "previous_period"
        ? previousPeriod(scope.range)
        : scope.compare;
  return (
    <section
      aria-label="Filters"
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
      data-testid="filter-bar"
    >
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeControl filters={filters} range={scope.range} onChange={setFilters} />
        {compare && <CompareControl filters={filters} range={scope.range} onChange={setFilters} />}
        {accounts && <PlatformFilter filters={filters} onChange={setFilters} />}
        {accounts && <AccountFilter filters={filters} onChange={setFilters} />}
        {granularity && (
          <GranularityControl filters={filters} range={scope.range} onChange={setFilters} />
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="resolved-range">
        {formatRange(scope.range)}
        {compare && comparison ? ` · compared with ${formatRange(comparison)}` : ""}
      </p>
      {dayBasis === "utc" ? (
        <p className="text-xs text-muted-foreground" data-testid="day-basis">
          Account metrics use UTC days and presets use UTC; post publish dates use {org.timezone}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Dates are each ad account&apos;s local days; presets use {org.timezone}.
        </p>
      )}
    </section>
  );
}
