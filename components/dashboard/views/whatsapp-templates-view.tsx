"use client";

import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Plus, RefreshCw, Settings } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import { languageLabel } from "@/lib/whatsapp/template-languages";
import {
  CATEGORY_LABELS,
  matchesFilter,
  rejectionText,
  STATUS_FILTERS,
  templateErrorNotice,
  templateStatus,
  unsupportedText,
  type StatusFilter,
} from "@/lib/whatsapp/template-messages";
import { ConnectionNotice } from "../connections/connection-notice";
import { EmptyState } from "../empty-state";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { TemplateBuilder } from "../whatsapp/template-builder";
import { TemplatePreview } from "../whatsapp/template-preview";

type TemplateList = FunctionReturnType<typeof api.v1.whatsapp.listAccountTemplates>;
type ManagedTemplate = TemplateList["templates"][number];

const FIELD =
  "rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Admin-only: deletes one template in one language after an explicit confirmation. */
function DeleteTemplate({
  accountId,
  template,
  onDeleted,
  onNotice,
}: {
  accountId: string;
  template: ManagedTemplate & { id: string };
  onDeleted: () => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const deleteTemplate = useAction(api.v1.whatsapp.deleteTemplate);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    onNotice(null);
    try {
      await deleteTemplate({
        accountId,
        templateId: template.id,
        name: template.name,
        language: template.language,
      });
      onNotice({
        tone: "success",
        title: "Template deleted",
        message: `“${template.name}” (${languageLabel(template.language)}) was deleted.`,
      });
      onDeleted();
    } catch (error) {
      onNotice(templateErrorNotice(error, "delete"));
    } finally {
      inFlight.current = false;
      setPending(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Delete
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="flex w-full flex-col gap-2 rounded-md border border-destructive/40 p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) setConfirming(false);
      }}
    >
      <p id={titleId} className="font-medium">
        Delete “{template.name}” ({languageLabel(template.language)})?
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>It can no longer be sent; messages already sent are not affected.</li>
        {template.status === "APPROVED" && (
          <li>Meta does not allow a new template with this name for 30 days.</li>
        )}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? "Deleting…" : "Delete"}
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

function TemplateCard({
  accountId,
  template,
  isAdmin,
  onDeleted,
  onNotice,
}: {
  accountId: string;
  template: ManagedTemplate;
  isAdmin: boolean;
  onDeleted: () => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const headingId = useId();
  const status = templateStatus(template.status);
  const rejection =
    template.status === "REJECTED" ? rejectionText(template.rejectedReason ?? "") : null;
  const unsupported =
    template.status === "APPROVED" ? unsupportedText(template.unsupportedReason) : null;
  const { id } = template;
  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="font-medium break-all">
          {template.name}
        </h3>
        <Badge variant={status.tone}>{status.label}</Badge>
        <Badge variant="outline">{CATEGORY_LABELS[template.category] ?? template.category}</Badge>
        <span className="text-sm text-muted-foreground">{languageLabel(template.language)}</span>
      </div>
      <TemplatePreview
        label={`${template.name} preview`}
        {...(template.header !== undefined ? { header: template.header } : {})}
        body={template.body}
        {...(template.footer !== undefined ? { footer: template.footer } : {})}
        buttons={template.buttons}
      />
      {rejection && <p className="text-sm text-destructive">{rejection}</p>}
      {unsupported && <p className="text-sm text-muted-foreground">{unsupported}</p>}
      {isAdmin && id !== undefined && (
        <div>
          <DeleteTemplate
            accountId={accountId}
            template={{ ...template, id }}
            onDeleted={onDeleted}
            onNotice={onNotice}
          />
        </div>
      )}
    </li>
  );
}

type Load =
  | { state: "loading" }
  | { state: "loaded"; list: TemplateList }
  | { state: "failed"; notice: Notice };

/** One account's templates, read from Meta when shown and on Refresh. */
function AccountTemplates({
  accountId,
  isAdmin,
  onNotice,
}: {
  accountId: string;
  isAdmin: boolean;
  onNotice: (notice: Notice | null) => void;
}) {
  const listTemplates = useAction(api.v1.whatsapp.listAccountTemplates);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [building, setBuilding] = useState(false);
  const request = useRef(0);

  // Asks Meta for the list; only its answer changes the state (the latest request wins).
  const fetchList = useCallback(() => {
    const current = ++request.current;
    listTemplates({ accountId }).then(
      (list) => {
        if (request.current === current) setLoad({ state: "loaded", list });
      },
      (error: unknown) => {
        if (request.current === current) {
          setLoad({ state: "failed", notice: templateErrorNotice(error, "list") });
        }
      },
    );
  }, [accountId, listTemplates]);

  // The component starts as loading (it is keyed by account), so the first fetch sets nothing.
  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const refresh = useCallback(() => {
    setLoad({ state: "loading" });
    fetchList();
  }, [fetchList]);

  const templates = load.state === "loaded" ? load.list.templates : [];
  const shown = templates.filter((t) => matchesFilter(t.status, filter));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && !building && (
          <Button type="button" onClick={() => setBuilding(true)}>
            <Plus aria-hidden="true" />
            New template
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={load.state === "loading"}
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {building && (
        <TemplateBuilder
          accountId={accountId}
          onCancel={() => setBuilding(false)}
          onDone={(notice) => {
            setBuilding(false);
            onNotice(notice);
            refresh();
          }}
        />
      )}
      <section aria-labelledby="template-list" className="flex flex-col gap-3">
        <h2 id="template-list" className="text-lg font-semibold">
          Templates
        </h2>
        <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.id}
              type="button"
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {load.state === "loaded" && (
                <span className="ml-1 opacity-70">
                  {templates.filter((t) => matchesFilter(t.status, f.id)).length}
                </span>
              )}
            </Button>
          ))}
        </div>
        {load.state === "loading" && (
          <Skeleton className="h-40 w-full" role="status" aria-label="Loading templates" />
        )}
        {load.state === "failed" && <ConnectionNotice notice={load.notice} />}
        {load.state === "loaded" &&
          (shown.length === 0 ? (
            <EmptyState
              title={templates.length === 0 ? "No templates yet" : "No templates with this status"}
            >
              {templates.length === 0
                ? isAdmin
                  ? "Create one with New template: start from a ready-made template or from scratch."
                  : "An admin can create templates here."
                : null}
            </EmptyState>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {shown.map((template) => (
                <TemplateCard
                  key={`${template.id ?? template.name}-${template.language}`}
                  accountId={accountId}
                  template={template}
                  isAdmin={isAdmin}
                  onDeleted={refresh}
                  onNotice={onNotice}
                />
              ))}
            </ul>
          ))}
        {load.state === "loaded" && !load.list.complete && (
          <p className="text-sm text-muted-foreground">Only the first 500 templates are shown.</p>
        )}
      </section>
    </div>
  );
}

function Templates({ onNotice }: { onNotice: (notice: Notice | null) => void }) {
  const { role } = useOrg();
  const isAdmin = role === "admin";
  const { data: accounts } = useAnalyticsQuery(api.v1.whatsapp.listAccounts, {});
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const [chosen, setChosen] = useState<string | null>(null);
  const selectId = useId();
  if (accounts === undefined) {
    return (
      <Skeleton className="h-24 w-full" role="status" aria-label="Loading WhatsApp accounts" />
    );
  }
  const active = accounts.filter((a) => a.status === "active");
  if (active.length === 0) {
    return (
      <EmptyState title="No WhatsApp account connected">
        Connect a WhatsApp Business number in the WhatsApp settings to create templates.
      </EmptyState>
    );
  }
  const names = new Map(
    (connections ?? [])
      .filter((c) => c.provider === "whatsapp" && c.displayName !== undefined)
      .map((c) => [c.id, c.displayName!]),
  );
  const accountId = active.some((a) => a.id === chosen) ? chosen! : active[0]!.id;
  const nameOf = (a: (typeof active)[number]) =>
    names.get(a.connectionId) ?? `WhatsApp Business account ${a.wabaId}`;
  return (
    <div className="flex flex-col gap-4">
      {active.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={selectId} className="text-sm font-medium">
            WhatsApp Business account
          </label>
          <select
            id={selectId}
            className={FIELD}
            value={accountId}
            onChange={(e) => {
              onNotice(null);
              setChosen(e.target.value);
            }}
          >
            {active.map((a) => (
              <option key={a.id} value={a.id}>
                {nameOf(a)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Templates of <span className="font-medium text-foreground">{nameOf(active[0]!)}</span>
        </p>
      )}
      <AccountTemplates
        key={accountId}
        accountId={accountId}
        isAdmin={isAdmin}
        onNotice={onNotice}
      />
    </div>
  );
}

/**
 * WhatsApp templates (/whatsapp/templates; ADR 0020): every template of a connected WhatsApp
 * Business Account with its review status, read from Meta; admins create templates (from a
 * ready-made one or from scratch) and delete them. Approved ones appear in the conversation's
 * template picker. The result of the latest action is shown at the top and receives focus.
 */
export function WhatsAppTemplatesView() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onNotice = useCallback((next: Notice | null) => setNotice(next), []);
  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs items={[{ label: "WhatsApp", href: "/whatsapp" }, { label: "Templates" }]} />
      <PageHeader
        title="WhatsApp templates"
        description="Messages Meta approved in advance: the only ones you can send when a customer has not written in the last 24 hours."
      >
        <div className="flex flex-wrap gap-2 pt-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/whatsapp/settings">
              <Settings aria-hidden="true" />
              WhatsApp settings
            </Link>
          </Button>
        </div>
      </PageHeader>
      {notice && (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <ConnectionNotice notice={notice} />
        </div>
      )}
      <QueryBoundary resetKey="whatsapp-templates" title="WhatsApp templates">
        <Templates onNotice={onNotice} />
      </QueryBoundary>
    </div>
  );
}
