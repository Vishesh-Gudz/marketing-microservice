"use client";

import { useMutation } from "convex/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import {
  INSTAGRAM_TEMPLATE_STARTERS,
  STARTER_GROUP_LABELS,
  type InstagramTemplateStarter,
} from "@/lib/instagram/template-starters";
import {
  KIND_LABELS,
  TEMPLATE_LIMITS,
  templateErrorNotice,
  type InstagramTemplate,
} from "@/lib/instagram/templates";
import { ConnectionNotice } from "../connections/connection-notice";
import { EmptyState } from "../empty-state";
import { TemplateBuilder, type TemplateDraft } from "../instagram/template-builder";
import { TemplatePreview } from "../instagram/template-preview";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

const EMPTY: TemplateDraft = {
  name: "",
  content: { kind: "buttons", text: "", buttons: [{ type: "reply", title: "" }] },
};

function fromStarter(starter: InstagramTemplateStarter): TemplateDraft {
  return { name: starter.name, content: structuredClone(starter.content) };
}

function fromTemplate(template: InstagramTemplate): TemplateDraft {
  return { id: template.id, name: template.name, content: structuredClone(template.content) };
}

/** Deletes one template after a confirmation. Messages already sent keep their content. */
function DeleteTemplate({
  template,
  onNotice,
}: {
  template: InstagramTemplate;
  onNotice: (notice: Notice | null) => void;
}) {
  const remove = useMutation(api.v1.instagramTemplates.remove);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Delete
      </Button>
    );
  }
  return (
    <span
      role="group"
      aria-label={`Delete ${template.name}?`}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      Delete “{template.name}”?
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() => {
          setPending(true);
          remove({ templateId: template.id }).then(
            () =>
              onNotice({
                tone: "success",
                title: "Template deleted",
                message: `“${template.name}” was deleted. Messages already sent with it stay as they were.`,
              }),
            (error: unknown) => {
              setPending(false);
              setConfirming(false);
              onNotice(templateErrorNotice(error));
            },
          );
        }}
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </span>
  );
}

/** The ready-made templates by group; choosing one opens the builder filled in. */
function StarterGallery({ onUse }: { onUse: (starter: InstagramTemplateStarter) => void }) {
  const groups = Object.keys(STARTER_GROUP_LABELS) as InstagramTemplateStarter["group"][];
  return (
    <section aria-labelledby="instagram-template-starters" className="flex flex-col gap-4">
      <h2 id="instagram-template-starters" className="text-lg font-semibold">
        Ready-made templates
      </h2>
      {groups.map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {STARTER_GROUP_LABELS[group]}
          </h3>
          <ul
            aria-label={STARTER_GROUP_LABELS[group]}
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          >
            {INSTAGRAM_TEMPLATE_STARTERS.filter((s) => s.group === group).map((starter) => (
              <li
                key={starter.id}
                aria-labelledby={`ig-starter-${starter.id}`}
                className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h4 id={`ig-starter-${starter.id}`} className="font-medium">
                    {starter.name}
                  </h4>
                  <Badge variant="outline">{KIND_LABELS[starter.content.kind]}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{starter.description}</p>
                <TemplatePreview content={starter.content} label={`${starter.name} preview`} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-auto self-start"
                  onClick={() => onUse(starter)}
                >
                  Use this template
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Templates({ onNotice }: { onNotice: (notice: Notice | null) => void }) {
  const { role } = useOrg();
  const canEdit = role === "admin" || role === "editor";
  const { data: templates } = useAnalyticsQuery(api.v1.instagramTemplates.list, {});
  const [editing, setEditing] = useState<TemplateDraft | null>(null);
  const [showStarters, setShowStarters] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const open = (draft: TemplateDraft) => {
    onNotice(null);
    setEditing(draft);
    setShowStarters(false);
  };
  useEffect(() => {
    if (editing !== null) formRef.current?.scrollIntoView?.({ block: "start" });
  }, [editing]);

  if (templates === undefined) {
    return <Skeleton className="h-40 w-full" role="status" aria-label="Loading templates" />;
  }
  const full = templates.length >= TEMPLATE_LIMITS.templates;
  return (
    <div className="flex flex-col gap-6">
      {canEdit && editing === null && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={full} onClick={() => open(structuredClone(EMPTY))}>
            <Plus aria-hidden="true" />
            New template
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-expanded={showStarters}
            disabled={full}
            onClick={() => setShowStarters((s) => !s)}
          >
            Ready-made templates
          </Button>
        </div>
      )}
      {editing !== null && (
        <div ref={formRef}>
          <TemplateBuilder
            key={editing.id ?? editing.name}
            initial={editing}
            onCancel={() => setEditing(null)}
            onDone={(notice) => {
              setEditing(null);
              onNotice(notice);
            }}
          />
        </div>
      )}
      {showStarters && editing === null && (
        <StarterGallery onUse={(starter) => open(fromStarter(starter))} />
      )}
      <section aria-labelledby="instagram-template-list" className="flex flex-col gap-3">
        <h2 id="instagram-template-list" className="text-lg font-semibold">
          Your templates
        </h2>
        {templates.length === 0 ? (
          <EmptyState title="No Instagram templates yet">
            {canEdit
              ? "Add your own, or start from a ready-made one: a welcome menu, product cards, bookings, order tracking and more."
              : "Editors and admins can add Instagram templates here."}
          </EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {templates.map((template) => (
              <li
                key={template.id}
                aria-label={template.name}
                className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{template.name}</h3>
                  <Badge variant="outline">{KIND_LABELS[template.content.kind]}</Badge>
                </div>
                <TemplatePreview content={template.content} label={`${template.name} preview`} />
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => open(fromTemplate(template))}
                    >
                      Edit
                    </Button>
                    <DeleteTemplate template={template} onNotice={onNotice} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Instagram templates (/instagram/messages/templates; ADR 0022): the org's reusable button
 * messages and cards, sent from an Instagram conversation while the customer's reply window is
 * open. Kept in this app only: Instagram has no Meta review for them. Every member sees them;
 * editors and admins add (from scratch or a ready-made one), edit and delete them.
 */
export function InstagramTemplatesView() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onNotice = useCallback((next: Notice | null) => setNotice(next), []);
  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[{ label: "Instagram DMs", href: "/instagram/messages" }, { label: "Templates" }]}
      />
      <PageHeader
        title="Instagram templates"
        description="Messages with buttons and swipeable cards, ready to send in any Instagram conversation while the customer's 24-hour reply window is open. No approval by Meta is needed."
      />
      {notice && (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <ConnectionNotice notice={notice} />
        </div>
      )}
      <QueryBoundary resetKey="instagram-templates" title="Instagram templates">
        <Templates onNotice={onNotice} />
      </QueryBoundary>
    </div>
  );
}
