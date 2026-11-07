"use client";

import { CalendarDays, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
import { cn } from "@/lib/utils";
import { PlatformName } from "./platform-name";

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

/**
 * Toolbar controls carry their label inside the control ("Compare  Previous period"); the
 * accessible name stays the plain label ("Compare"), from a visually hidden element.
 */
function Prefix({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="text-muted-foreground">
      {children}
    </span>
  );
}

/** A select trigger across the sheet: label and value on the left, the chevron at the end. */
const STACKED_TRIGGER = "w-full justify-start [&>svg:last-child]:ml-auto";

type ControlProps = {
  filters: DashboardFilters;
  range: Range;
  onChange: (next: DashboardFilters) => void;
  /** Full-width controls, one per line (the phone filter sheet). */
  stacked?: boolean;
};

function DateRangeControl({ filters, range, onChange, stacked }: ControlProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const custom = filters.preset === "custom" || editing;
  return (
    <div className={cn("flex flex-wrap items-end gap-2", stacked && "flex-col items-stretch")}>
      <div className="grid">
        <span className="sr-only" id={`${id}-label`}>
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
          <SelectTrigger
            size="sm"
            className={stacked ? STACKED_TRIGGER : "min-w-40"}
            aria-labelledby={`${id}-label`}
          >
            <CalendarDays className="size-4" aria-hidden="true" />
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

function CompareControl({ filters, range, onChange, stacked }: ControlProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const custom = filters.compare === "custom" || editing;
  const initial =
    filters.compareFrom && filters.compareTo
      ? { from: filters.compareFrom, to: filters.compareTo }
      : previousPeriod(range);
  return (
    <div className={cn("flex flex-wrap items-end gap-2", stacked && "flex-col items-stretch")}>
      <div className="grid">
        <span className="sr-only" id={`${id}-label`}>
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
          <SelectTrigger
            size="sm"
            className={stacked ? STACKED_TRIGGER : "min-w-40"}
            aria-labelledby={`${id}-label`}
          >
            <Prefix>Compare</Prefix>
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

function PlatformFilter({ filters, onChange, stacked }: Omit<ControlProps, "range">) {
  const id = useId();
  return (
    <div className="grid">
      <span className="sr-only" id={`${id}-label`}>
        Platforms
      </span>
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        role="group"
        aria-labelledby={`${id}-label`}
        className={stacked ? "w-full *:flex-1" : undefined}
        value={filters.platforms}
        onValueChange={(value) => onChange({ ...filters, platforms: value as AdPlatform[] })}
      >
        {PLATFORMS.map((platform) => (
          <ToggleGroupItem key={platform} value={platform} className="px-3">
            <PlatformName platform={platform} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function accountsLabel(filters: DashboardFilters): string {
  return filters.accounts.length === 0
    ? "All accounts"
    : `${filters.accounts.length} ${filters.accounts.length === 1 ? "account" : "accounts"}`;
}

function AccountFilter({ filters, onChange, stacked }: Omit<ControlProps, "range">) {
  const id = useId();
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});
  const selectable = (accounts ?? []).filter((a) => !a.isManager);
  const selected = new Set(filters.accounts);
  const label = accountsLabel(filters);
  const toggle = (accountId: string, checked: boolean) => {
    const next = checked
      ? [...filters.accounts, accountId].slice(0, MAX_ACCOUNT_FILTER)
      : filters.accounts.filter((a) => a !== accountId);
    onChange({ ...filters, accounts: next });
  };
  return (
    <div className="grid">
      <span className="sr-only" id={`${id}-label`}>
        Accounts
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn("justify-between font-normal", stacked ? "w-full" : "min-w-40")}
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
                      <PlatformName platform={account.platform} className="align-middle" /> ·{" "}
                      {account.currency}
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

function GranularityControl({ filters, range, onChange, stacked }: ControlProps) {
  const id = useId();
  const auto = autoGranularity(rangeDays(range));
  return (
    <div className="grid">
      <span className="sr-only" id={`${id}-label`}>
        Interval
      </span>
      <Select
        value={filters.granularity}
        onValueChange={(value) =>
          onChange({ ...filters, granularity: value as GranularitySetting })
        }
      >
        <SelectTrigger
          size="sm"
          className={stacked ? STACKED_TRIGGER : "min-w-36"}
          aria-labelledby={`${id}-label`}
        >
          <Prefix>Interval</Prefix>
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

/** Below md: a "Filters" button with the current selection; the controls open in a bottom sheet. */
function PhoneFilters({ summary, children }: { summary: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start font-normal"
            aria-describedby={`${id}-summary`}
          >
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            <span className="font-medium">Filters</span>
            <span
              id={`${id}-summary`}
              aria-hidden="true"
              className="min-w-0 truncate text-muted-foreground"
            >
              {summary}
            </span>
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 rounded-t-[14px] bg-paper">
          <SheetHeader className="border-b border-line">
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>Changes apply as you make them.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 overflow-y-auto p-4">{children}</div>
          <div className="border-t border-line p-4">
            <Button className="w-full" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * Global filters (D3/D12). Everything is URL state; each view enables only the
 * controls its API query accepts (e.g. entity views take no account filters).
 * `dayBasis="utc"` (organic Instagram) resolves presets against today in UTC and says so;
 * `dayBasis="pacific"` (YouTube) against today in Pacific Time; the default ("org") is the
 * paid dashboard's behavior, unchanged.
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
  const controls = (stacked: boolean) => (
    <>
      <DateRangeControl
        filters={filters}
        range={scope.range}
        onChange={setFilters}
        stacked={stacked}
      />
      {compare && (
        <CompareControl
          filters={filters}
          range={scope.range}
          onChange={setFilters}
          stacked={stacked}
        />
      )}
      {accounts && <PlatformFilter filters={filters} onChange={setFilters} stacked={stacked} />}
      {accounts && <AccountFilter filters={filters} onChange={setFilters} stacked={stacked} />}
      {granularity && (
        <GranularityControl
          filters={filters}
          range={scope.range}
          onChange={setFilters}
          stacked={stacked}
        />
      )}
    </>
  );
  const summary = [
    filters.preset === "custom" ? "Custom range" : PRESET_LABELS[filters.preset],
    ...(accounts && filters.platforms.length > 0
      ? [filters.platforms.map(humanize).join(", ")]
      : []),
    ...(accounts ? [accountsLabel(filters)] : []),
  ].join(" · ");
  return (
    <section aria-label="Filters" className="flex flex-col gap-1.5" data-testid="filter-bar">
      {/* Phones: one summary button; the controls open in a sheet. */}
      <PhoneFilters summary={summary}>{controls(true)}</PhoneFilters>
      <div className="hidden flex-wrap items-end gap-2 md:flex">{controls(false)}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <p className="text-xs text-muted-foreground" data-testid="resolved-range">
          {formatRange(scope.range)}
          {compare && comparison ? ` · compared with ${formatRange(comparison)}` : ""}
        </p>
        {dayBasis === "utc" ? (
          <p className="text-xs text-muted-foreground" data-testid="day-basis">
            Account metrics use UTC days and presets use UTC; post publish dates use {org.timezone}.
          </p>
        ) : dayBasis === "pacific" ? (
          <p className="text-xs text-muted-foreground" data-testid="day-basis">
            Channel metrics use YouTube&apos;s Pacific Time days and presets use Pacific Time; video
            publish dates use {org.timezone}.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Dates are each ad account&apos;s local days; presets use {org.timezone}.
          </p>
        )}
      </div>
    </section>
  );
}
