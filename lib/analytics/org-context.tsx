"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { todayIn } from "@/convex/lib/dates";
import type { Org } from "./types";

/**
 * The caller's organization (from v1/orgs:me), provided by OrgGate. Its
 * timezone defines "today" for presets; its reporting currency is the display
 * currency. The org id itself is never sent as an argument (tenancy comes from
 * the token).
 */
const OrgContext = createContext<Org | null>(null);

export function OrgProvider({ org, children }: { org: Org; children: ReactNode }) {
  return <OrgContext value={org}>{children}</OrgContext>;
}

export function useOrg(): Org {
  const org = useContext(OrgContext);
  if (org === null) throw new Error("useOrg must be used inside OrgGate.");
  return org;
}

/** Today in the org timezone; re-checked every minute so presets roll over at midnight. */
export function useOrgToday(): string {
  const { timezone } = useOrg();
  const [today, setToday] = useState(() => ({ timezone, key: todayIn(timezone) }));
  useEffect(() => {
    const tick = () =>
      setToday((previous) => {
        const key = todayIn(timezone);
        return previous.key === key && previous.timezone === timezone
          ? previous
          : { timezone, key };
      });
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [timezone]);
  // A timezone change applies on the next tick; until then keep the last known day.
  return today.key;
}

/**
 * Today in UTC; re-checked every minute. Organic (Instagram) account metrics are keyed by UTC
 * day, so their presets resolve against this day, not the org's (Phase 10 Stage B, R12).
 */
export function useUtcToday(): string {
  const [today, setToday] = useState(() => todayIn("UTC"));
  useEffect(() => {
    const timer = setInterval(() => {
      setToday((previous) => {
        const key = todayIn("UTC");
        return previous === key ? previous : key;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  return today;
}
