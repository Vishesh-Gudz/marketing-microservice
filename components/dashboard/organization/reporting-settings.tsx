"use client";

import { useMutation } from "convex/react";
import { ChevronDown } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { getDisplayLocale } from "@/lib/analytics/format";
import { useOrg } from "@/lib/analytics/org-context";
import type { Org } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import {
  browserTimeZone,
  currencyGroups,
  currencyLabel,
  settingsErrorNotice,
  soleAccountCurrency,
  timeZoneGroups,
  type Option,
} from "@/lib/org/reporting";
import { cn } from "@/lib/utils";
import { ConnectionNotice } from "../connections/connection-notice";
import { SECTION_HEADING, SURFACE } from "../surface";

/** The anchor the top-bar currency badge and the conversion notice link to. */
export const REPORTING_ANCHOR = "reporting";

const FIELD =
  "h-9 w-full appearance-none rounded-[10px] border border-input bg-paper pr-9 pl-3 text-sm text-ink transition-[border-color] hover:border-line-stronger focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A native select: the time zone list has some 400 entries, which the browser's own picker
 * handles best (type-ahead, phone wheels), grouped and labelled.
 */
function GroupedSelect({
  label,
  value,
  groups,
  onChange,
  disabled,
  describedBy,
}: {
  label: string;
  value: string;
  groups: { label: string; options: Option[] }[];
  onChange: (value: string) => void;
  disabled: boolean;
  describedBy?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          className={FIELD}
          onChange={(event) => onChange(event.target.value)}
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    </div>
  );
}

/** The form for admins, started from the stored values (remounted when they change). */
function ReportingForm({
  org,
  onSaved,
  onEdited,
}: {
  org: Org;
  onSaved: (notice: Notice) => void;
  /** A field changed: an earlier "Saved" no longer describes the form. */
  onEdited: () => void;
}) {
  const updateSettings = useMutation(api.v1.orgs.updateSettings);
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});
  const [currency, setCurrency] = useState(org.reportingCurrency);
  const [timezone, setTimezone] = useState(org.timezone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const hintId = useId();
  const [now] = useState(() => Date.now());
  const locale = getDisplayLocale();
  const accountCurrency = soleAccountCurrency(accounts);
  const changed = currency !== org.reportingCurrency || timezone !== org.timezone;
  const chooseCurrency = (value: string) => {
    setCurrency(value);
    onEdited();
  };
  const chooseTimezone = (value: string) => {
    setTimezone(value);
    onEdited();
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !changed) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await updateSettings({
        ...(currency !== org.reportingCurrency ? { reportingCurrency: currency } : {}),
        ...(timezone !== org.timezone ? { timezone } : {}),
      });
      onSaved({
        tone: "success",
        title: "Saved",
        message: `Every page now uses ${currency} and ${timezone}.`,
      });
    } catch (caught) {
      setError(settingsErrorNotice(caught));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      {error && <ConnectionNotice notice={error} />}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <GroupedSelect
            label="Reporting currency"
            value={currency}
            groups={currencyGroups(currency, locale)}
            onChange={chooseCurrency}
            disabled={pending}
            {...(accountCurrency !== undefined ? { describedBy: hintId } : {})}
          />
          {accountCurrency !== undefined && (
            <p id={hintId} className="flex flex-wrap items-center gap-x-2 text-xs text-ink-2">
              <span>Your ad accounts report in {accountCurrency}.</span>
              {accountCurrency !== currency && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  disabled={pending}
                  onClick={() => chooseCurrency(accountCurrency)}
                >
                  Use {accountCurrency}
                </Button>
              )}
            </p>
          )}
        </div>
        <GroupedSelect
          label="Time zone"
          value={timezone}
          groups={timeZoneGroups(timezone, browserTimeZone(), now, locale)}
          onChange={chooseTimezone}
          disabled={pending}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {changed && !pending && (
          <span className="text-xs text-muted-foreground">Not saved yet</span>
        )}
      </div>
    </form>
  );
}

/**
 * The organization's reporting settings (C1): the currency totals are shown in, and the time
 * zone that sets "today", the date presets and the times in the inbox. Admins change them
 * (`v1/orgs:updateSettings`, which checks the role and every value again); everyone else sees
 * them. Every page follows the saved values at once (the organization is a live query).
 */
export function ReportingSettings() {
  const org = useOrg();
  const headingId = useId();
  const [saved, setSaved] = useState<Notice | null>(null);
  const admin = org.role === "admin";
  return (
    <section
      id={REPORTING_ANCHOR}
      aria-labelledby={headingId}
      className={cn(SURFACE, "flex scroll-mt-20 flex-col gap-4 p-5 md:p-6")}
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className={SECTION_HEADING}>
          Reporting
        </h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Totals are shown in the reporting currency. The time zone sets &ldquo;today&rdquo;, the
          date presets and the times in the inbox.
        </p>
      </div>
      {saved && <ConnectionNotice notice={saved} />}
      {admin ? (
        <ReportingForm
          key={`${org.reportingCurrency}|${org.timezone}`}
          org={org}
          onSaved={setSaved}
          onEdited={() => setSaved(null)}
        />
      ) : (
        <>
          <dl className="grid gap-4 text-sm md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Reporting currency</dt>
              <dd className="font-medium text-ink">
                {currencyLabel(org.reportingCurrency, getDisplayLocale())}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Time zone</dt>
              <dd className="font-medium text-ink">{org.timezone}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">Only admins can change these.</p>
        </>
      )}
    </section>
  );
}
