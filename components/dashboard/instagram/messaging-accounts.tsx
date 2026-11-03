"use client";

import { useAction, useMutation } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import { Input } from "@/components/ui/input";
import {
  accountLabel,
  AVAILABILITY_TEXT,
  controlErrorNotice,
  iceBreakerErrorNotice,
  MAX_ICE_BREAKER_CHARS,
  MAX_ICE_BREAKERS,
  setupReasonText,
  setupResultNotice,
  SUGGESTED_ICE_BREAKERS,
} from "@/lib/instagram/messages";
import type { MessagingAvailability } from "@/lib/instagram/types";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";

/** Linked social accounts read at once (as the Organic page). */
const ACCOUNTS_PAGE = 100;

type OnNotice = (notice: Notice | null) => void;

/** One action at a time per control; a second click while one runs does nothing. */
function useOnce() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return { pending, run };
}

function TurnOn({ socialAccountId, onNotice }: { socialAccountId: string; onNotice: OnNotice }) {
  const enable = useAction(api.v1.instagramMessaging.enable);
  const { pending, run } = useOnce();
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      onClick={() =>
        void run(async () => {
          onNotice(null);
          try {
            onNotice(setupResultNotice(await enable({ socialAccountId })));
          } catch (error) {
            onNotice(controlErrorNotice(error));
          }
        })
      }
    >
      {pending ? "Turning on…" : "Turn on direct messages"}
    </Button>
  );
}

function RetrySetup({ accountId, onNotice }: { accountId: string; onNotice: OnNotice }) {
  const retry = useAction(api.v1.instagramMessaging.retrySetup);
  const { pending, run } = useOnce();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        void run(async () => {
          onNotice(null);
          try {
            onNotice(setupResultNotice(await retry({ accountId })));
          } catch (error) {
            onNotice(controlErrorNotice(error));
          }
        })
      }
    >
      {pending ? "Retrying…" : "Retry setup"}
    </Button>
  );
}

/**
 * Turning direct messages off, after an explicit confirmation that says what happens to the
 * stored messages (the 30-day grace period, ADR 0017 D14). The safe choice gets the focus.
 */
function TurnOff({
  accountId,
  name,
  onNotice,
}: {
  accountId: string;
  name: string;
  onNotice: OnNotice;
}) {
  const disable = useMutation(api.v1.instagramMessaging.disable);
  const { timezone } = useOrg();
  const { pending, run } = useOnce();
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (opened.current) triggerRef.current?.focus();
    opened.current = confirming;
  }, [confirming]);

  function confirm() {
    void run(async () => {
      onNotice(null);
      try {
        const account = await disable({ accountId });
        onNotice({
          tone: "success",
          title: "Direct messages are off",
          message:
            account.purgeAfter !== undefined
              ? `Stored conversations are kept until ${formatInstant(account.purgeAfter, timezone)}, then deleted, unless you turn direct messages on again before.`
              : "New direct messages no longer reach this inbox.",
        });
      } catch (error) {
        onNotice(controlErrorNotice(error));
      } finally {
        setConfirming(false);
      }
    });
  }

  if (!confirming) {
    return (
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        Turn off
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="flex w-full flex-col gap-3 rounded-md border border-destructive/40 p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) setConfirming(false);
      }}
    >
      <p id={titleId} className="font-medium">
        Turn off direct messages for {name}?
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>New direct messages stop reaching this inbox at once, and no reply can be sent.</li>
        <li>
          Conversations and messages so far are kept for 30 days, then deleted. Turning direct
          messages on again within those 30 days keeps them.
        </li>
        <li>Another organization may then turn on direct messages for this account.</li>
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="destructive" disabled={pending} onClick={confirm}>
          {pending ? "Turning off…" : "Turn off"}
        </Button>
        <Button
          ref={cancelRef}
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** What the account's state allows an admin to do. */
function Controls({
  socialAccountId,
  name,
  availability,
  onNotice,
}: {
  socialAccountId: string;
  name: string;
  availability: MessagingAvailability;
  onNotice: OnNotice;
}) {
  const accountId = availability.accountId;
  switch (availability.availability) {
    case "ready":
      return <TurnOn socialAccountId={socialAccountId} onNotice={onNotice} />;
    case "active":
      return accountId === undefined ? null : (
        <TurnOff accountId={accountId} name={name} onNotice={onNotice} />
      );
    case "action_required":
      return accountId === undefined ? null : (
        <div className="flex flex-wrap gap-2">
          <RetrySetup accountId={accountId} onNotice={onNotice} />
          <TurnOff accountId={accountId} name={name} onNotice={onNotice} />
        </div>
      );
    default:
      return null;
  }
}

/**
 * Ice breakers (ADR 0021): up to 4 questions Instagram shows people opening a chat with the
 * account; a tap arrives in the inbox as their message. Admins set or remove them
 * (v1/instagramMessaging:setIceBreakers / clearIceBreakers); everyone sees them.
 */
function IceBreakers({
  accountId,
  current,
  isAdmin,
  onNotice,
}: {
  accountId: string;
  current: readonly string[] | undefined;
  isAdmin: boolean;
  onNotice: OnNotice;
}) {
  const setIceBreakers = useAction(api.v1.instagramMessaging.setIceBreakers);
  const clearIceBreakers = useAction(api.v1.instagramMessaging.clearIceBreakers);
  const [editing, setEditing] = useState<string[] | null>(null);
  const { pending, run } = useOnce();
  const headingId = useId();
  const filled = (editing ?? []).map((q) => q.trim()).filter((q) => q !== "");
  const valid =
    filled.length > 0 &&
    filled.length <= MAX_ICE_BREAKERS &&
    filled.every((q) => q.length <= MAX_ICE_BREAKER_CHARS) &&
    new Set(filled).size === filled.length;

  return (
    <section
      aria-labelledby={headingId}
      className="flex w-full flex-col gap-2 rounded-md border p-3"
    >
      <h4 id={headingId} className="text-sm font-medium">
        Ice breakers
      </h4>
      <p className="text-xs text-muted-foreground">
        Up to 4 questions Instagram shows people who open a chat with you. A tap arrives here as
        their message, and you can reply right away.
      </p>
      {editing === null ? (
        <>
          {current !== undefined && current.length > 0 ? (
            <ul aria-label="Current ice breakers" className="flex flex-wrap gap-2">
              {current.map((question) => (
                <li key={question} className="rounded-full border px-3 py-1 text-sm">
                  {question}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None set from here.</p>
          )}
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setEditing(
                    current !== undefined && current.length > 0
                      ? [...current, "", "", "", ""].slice(0, MAX_ICE_BREAKERS)
                      : [...SUGGESTED_ICE_BREAKERS],
                  )
                }
              >
                {current !== undefined && current.length > 0
                  ? "Edit ice breakers"
                  : "Set ice breakers"}
              </Button>
              {current !== undefined && current.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      onNotice(null);
                      try {
                        await clearIceBreakers({ accountId });
                        onNotice({
                          tone: "success",
                          title: "Ice breakers removed",
                          message: "Instagram no longer shows them to new chats.",
                        });
                      } catch (error) {
                        onNotice(iceBreakerErrorNotice(error));
                      }
                    })
                  }
                >
                  {pending ? "Removing…" : "Remove"}
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <form
          aria-label="Edit ice breakers"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            void run(async () => {
              onNotice(null);
              try {
                await setIceBreakers({ accountId, questions: filled });
                setEditing(null);
                onNotice({
                  tone: "success",
                  title: "Ice breakers saved",
                  message: "Instagram shows them to people who open a chat with you.",
                });
              } catch (error) {
                onNotice(iceBreakerErrorNotice(error));
              }
            });
          }}
        >
          {editing.map((question, i) => (
            <div key={i} className="flex flex-col gap-1">
              <label htmlFor={`${headingId}-q${i}`} className="text-xs text-muted-foreground">
                Question {i + 1}
                {i > 0 ? " (optional)" : ""}
              </label>
              <Input
                id={`${headingId}-q${i}`}
                value={question}
                maxLength={MAX_ICE_BREAKER_CHARS}
                onChange={(e) => setEditing(editing.map((q, j) => (j === i ? e.target.value : q)))}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending || !valid}>
              {pending ? "Saving…" : "Save ice breakers"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function AccountRow({
  socialAccountId,
  username,
  setupReasons,
  iceBreakers,
  isAdmin,
  onNotice,
}: {
  socialAccountId: string;
  username: string | undefined;
  /** Sanitized setup reasons of the org's messaging accounts, by account id. */
  setupReasons: ReadonlyMap<string, string | undefined>;
  /** The ice breakers of the org's messaging accounts, by account id. */
  iceBreakers: ReadonlyMap<string, readonly string[] | undefined>;
  isAdmin: boolean;
  onNotice: OnNotice;
}) {
  const { timezone } = useOrg();
  const { data: availability } = useAnalyticsQuery(api.v1.instagramMessaging.getAvailability, {
    socialAccountId,
  });
  const name = accountLabel(username);
  if (availability === undefined) {
    return (
      <li className="p-4">
        <Skeleton className="h-12 w-full" role="status" aria-label={`Loading ${name}`} />
      </li>
    );
  }
  const state = AVAILABILITY_TEXT[availability.availability];
  const on = availability.availability === "active";
  return (
    <li className="flex flex-col items-start gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{name}</h3>
        <Badge variant={on ? "secondary" : "outline"}>{state.label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {availability.availability === "action_required" && availability.accountId !== undefined
          ? `${state.text} ${setupReasonText(setupReasons.get(availability.accountId))}`
          : state.text}
      </p>
      {availability.purgeAfter !== undefined && availability.availability !== "active" && (
        <p className="text-sm text-muted-foreground">
          Conversations from before are kept until{" "}
          {formatInstant(availability.purgeAfter, timezone)}, then deleted, unless direct messages
          are turned on again before.
        </p>
      )}
      {isAdmin ? (
        <Controls
          socialAccountId={socialAccountId}
          name={name}
          availability={availability}
          onNotice={onNotice}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Only organization admins can turn direct messages on or off.
        </p>
      )}
      {availability.accountId !== undefined &&
        (availability.availability === "active" ||
          availability.availability === "action_required") && (
          <IceBreakers
            accountId={availability.accountId}
            current={iceBreakers.get(availability.accountId)}
            isAdmin={isAdmin}
            onNotice={onNotice}
          />
        )}
    </li>
  );
}

/**
 * Every linked Instagram account of the org with how its direct messages stand (v1
 * getAvailability) and, for admins, the controls that state allows: turn on, retry the setup,
 * turn off. Connecting or reconnecting Instagram is done by the integration that manages the
 * connection; this page only explains when that is needed.
 */
export function MessagingAccounts({ onNotice }: { onNotice: OnNotice }) {
  const { role } = useOrg();
  const { data } = useAnalyticsQuery(api.v1.socialAccounts.list, {
    paginationOpts: { numItems: ACCOUNTS_PAGE, cursor: null },
  });
  const { data: messaging } = useAnalyticsQuery(api.v1.instagramMessaging.listAccounts, {});
  if (data === undefined || messaging === undefined) {
    return (
      <Skeleton className="h-24 w-full" role="status" aria-label="Loading Instagram accounts" />
    );
  }
  const accounts = data.page.filter(
    (account) => account.platform === "instagram" && account.linked,
  );
  if (accounts.length === 0) {
    return (
      <EmptyState title="No Instagram account linked">
        Direct messages work with an Instagram professional (business or creator) account that is
        connected and linked through your integration. Once one is linked, it appears here.
      </EmptyState>
    );
  }
  const setupReasons = new Map(messaging.map((account) => [account.id, account.setupReason]));
  const iceBreakers = new Map(messaging.map((account) => [account.id, account.iceBreakers]));
  return (
    <ul aria-label="Instagram accounts" className="flex flex-col divide-y rounded-lg border">
      {accounts.map((account) => (
        <AccountRow
          key={account.id}
          socialAccountId={account.id}
          username={account.username}
          setupReasons={setupReasons}
          iceBreakers={iceBreakers}
          isAdmin={role === "admin"}
          onNotice={onNotice}
        />
      ))}
    </ul>
  );
}
