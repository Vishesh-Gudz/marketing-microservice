"use client";

import { useMutation } from "convex/react";
import { LayoutTemplate } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import { enterRunsOwnAction } from "@/lib/messaging/enter-key";
import {
  fillTemplateContent,
  KIND_LABELS,
  templateSendErrorNotice,
  templateSummary,
  type InstagramTemplate,
} from "@/lib/instagram/templates";
import { newClientMessageId } from "@/lib/whatsapp/inbox";
import { ConnectionNotice } from "../connections/connection-notice";
import { TemplatePreview } from "./template-preview";

/**
 * "Templates" in an Instagram reply box (ADR 0022): lists the org's Instagram templates (loaded
 * only once opened), previews the chosen one for this customer (`{{customer_name}}` filled in)
 * and sends it with v1/instagramMessaging:sendTemplate. The choice keeps its `clientMessageId`
 * until it is sent or another one is chosen, so sending again after an error never sends it
 * twice. Refusals are shown in fixed words.
 */
export function TemplatePicker({
  accountId,
  conversationId,
  contactName,
  humanAgent = false,
  disabled = false,
}: {
  accountId: string;
  conversationId: string;
  contactName?: string;
  humanAgent?: boolean;
  disabled?: boolean;
}) {
  const sendTemplate = useMutation(api.v1.instagramMessaging.sendTemplate);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<InstagramTemplate | null>(null);
  const [draftId, setDraftId] = useState(newClientMessageId);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const panelId = useId();
  const searchId = useId();
  const { data: templates } = useAnalyticsQuery(api.v1.instagramTemplates.list, open ? {} : "skip");
  const term = search.trim().toLowerCase();
  const shown = (templates ?? []).filter(
    (template) =>
      term === "" ||
      template.name.toLowerCase().includes(term) ||
      templateSummary(template.content).toLowerCase().includes(term),
  );

  function choose(template: InstagramTemplate | null) {
    setChosen(template);
    setNotice(null);
    setDraftId(newClientMessageId());
  }

  async function send() {
    if (inFlight.current || chosen === null) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    try {
      await sendTemplate({
        accountId,
        conversationId,
        templateId: chosen.id,
        clientMessageId: draftId,
      });
      setChosen(null);
      setOpen(false);
      setSearch("");
      setDraftId(newClientMessageId());
    } catch (error) {
      setNotice(templateSendErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled || pending}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o);
          choose(null);
        }}
      >
        <LayoutTemplate aria-hidden="true" />
        Templates
      </Button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Instagram templates"
          className="flex flex-col gap-3 rounded-md border p-3"
        >
          {notice && <ConnectionNotice notice={notice} />}
          {chosen === null ? (
            <>
              <label htmlFor={searchId} className="sr-only">
                Search templates
              </label>
              <Input
                id={searchId}
                value={search}
                placeholder="Search templates"
                onKeyDown={enterRunsOwnAction()}
                onChange={(e) => setSearch(e.target.value)}
              />
              {templates === undefined ? (
                <Skeleton className="h-16 w-full" role="status" aria-label="Loading templates" />
              ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {templates.length === 0
                    ? "No Instagram templates yet. "
                    : "No template matches. "}
                  <Link
                    href="/instagram/messages/templates"
                    className="underline underline-offset-4"
                  >
                    Manage templates
                  </Link>
                </p>
              ) : (
                <ul
                  aria-label="Templates to send"
                  className="flex max-h-64 flex-col gap-1 overflow-y-auto"
                >
                  {shown.map((template) => (
                    <li key={template.id}>
                      <button
                        type="button"
                        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                        onClick={() => choose(template)}
                      >
                        <span className="font-medium">
                          {template.name}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            · {KIND_LABELS[template.content.kind]}
                          </span>
                        </span>
                        <span className="line-clamp-2 text-muted-foreground">
                          {templateSummary(template.content)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <p className="text-sm font-medium">{chosen.name}</p>
              <TemplatePreview
                content={fillTemplateContent(chosen.content, contactName)}
                label="What the customer receives"
              />
              <p className="text-xs text-muted-foreground">
                Shown with its buttons in the Instagram app (not on instagram.com).
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={pending} onClick={() => void send()}>
                  {pending ? "Sending…" : humanAgent ? "Send as human agent" : "Send template"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => choose(null)}
                >
                  Choose another
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
