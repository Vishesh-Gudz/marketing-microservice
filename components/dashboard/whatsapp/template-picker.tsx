"use client";

import { useAction } from "convex/react";
import { useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { newClientMessageId } from "@/lib/whatsapp/inbox";
import { sendErrorNotice } from "@/lib/whatsapp/messages";
import {
  missingVariables,
  templatePreview,
  templateValues,
  unsupportedTemplateText,
  variableKey,
  variableLabel,
  type TemplateFormValues,
} from "@/lib/whatsapp/template-form";
import type { WhatsAppTemplate, WhatsAppTemplateList } from "@/lib/whatsapp/types";
import { ConnectionNotice } from "../connections/connection-notice";

type Step =
  | { step: "closed" }
  | { step: "loading" }
  | { step: "list"; list: WhatsAppTemplateList }
  | {
      step: "form";
      list: WhatsAppTemplateList;
      template: WhatsAppTemplate;
      values: TemplateFormValues;
      draftId: string;
    };

function TemplateForm({
  template,
  values,
  pending,
  onChange,
  onSend,
  onBack,
}: {
  template: WhatsAppTemplate;
  values: TemplateFormValues;
  pending: boolean;
  onChange: (key: string, value: string) => void;
  onSend: () => void;
  onBack: () => void;
}) {
  const formId = useId();
  const missing = missingVariables(template, values);
  return (
    <form
      className="flex flex-col gap-3"
      aria-labelledby={`${formId}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <p id={`${formId}-title`} className="font-medium">
        {template.name} <span className="text-muted-foreground">({template.language})</span>
      </p>
      {template.variables.length === 0 && (
        <p className="text-sm text-muted-foreground">This template has nothing to fill in.</p>
      )}
      {template.variables.map((variable) => {
        const key = variableKey(variable);
        const id = `${formId}-${key}`;
        return (
          <div key={key} className="flex flex-col gap-1">
            <Label htmlFor={id}>{variableLabel(variable, template)}</Label>
            <Input
              id={id}
              value={values[key] ?? ""}
              placeholder={variable.example}
              disabled={pending}
              onChange={(event) => onChange(key, event.target.value)}
            />
          </div>
        );
      })}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Preview</p>
        <p
          aria-label="Template preview"
          className="rounded-md bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap"
        >
          {templatePreview(template, values)}
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || missing.length > 0}>
          {pending ? "Sending…" : "Send template"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

/**
 * Choose an APPROVED template, fill in its values and send it (v1/whatsapp:listTemplates and
 * sendTemplate), for editors and admins, whether or not the reply window is open. Templates are
 * read from Meta when the picker opens; ones this app cannot send yet are listed with the reason
 * and cannot be chosen. The server checks every value again before anything is stored.
 */
export function TemplatePicker({ conversationId }: { conversationId: string }) {
  const listTemplates = useAction(api.v1.whatsapp.listTemplates);
  const sendTemplate = useAction(api.v1.whatsapp.sendTemplate);
  const [state, setState] = useState<Step>({ step: "closed" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function open() {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    setState({ step: "loading" });
    try {
      setState({ step: "list", list: await listTemplates({ conversationId }) });
    } catch (error) {
      setNotice(sendErrorNotice(error));
      setState({ step: "closed" });
    } finally {
      inFlight.current = false;
    }
  }

  async function send(form: Extract<Step, { step: "form" }>) {
    if (inFlight.current || missingVariables(form.template, form.values).length > 0) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    try {
      await sendTemplate({
        conversationId,
        templateName: form.template.name,
        language: form.template.language,
        variables: templateValues(form.template, form.values),
        clientMessageId: form.draftId,
      });
      setState({ step: "closed" });
      setNotice({
        tone: "success",
        title: "Template sent",
        message: "It appears in the conversation, where its delivery status follows.",
      });
    } catch (error) {
      setNotice(sendErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {notice && <ConnectionNotice notice={notice} />}
      {state.step === "closed" && (
        <Button type="button" variant="outline" className="self-start" onClick={() => void open()}>
          Choose a template
        </Button>
      )}
      {state.step === "loading" && (
        <Skeleton className="h-24 w-full" role="status" aria-label="Loading templates" />
      )}
      {state.step === "list" && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">Approved templates</p>
          {state.list.templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This WhatsApp account has no approved templates yet. Templates are created and
              approved in Meta&apos;s WhatsApp Manager.
            </p>
          ) : (
            <ul aria-label="Approved templates" className="flex flex-col gap-2">
              {state.list.templates.map((template) => (
                <li
                  key={`${template.name}:${template.language}`}
                  className="flex flex-col gap-1 rounded-md border p-3 text-sm"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{template.name}</span>
                    <Badge variant="outline">{template.language}</Badge>
                    <Badge variant="secondary">{template.category}</Badge>
                  </span>
                  <span className="break-words whitespace-pre-wrap text-muted-foreground">
                    {template.body}
                  </span>
                  {template.supported ? (
                    <Button
                      type="button"
                      size="sm"
                      className="self-start"
                      aria-label={`Use ${template.name} (${template.language})`}
                      onClick={() =>
                        setState({
                          step: "form",
                          list: state.list,
                          template,
                          values: {},
                          draftId: newClientMessageId(),
                        })
                      }
                    >
                      Use this template
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Not supported yet: {unsupportedTemplateText(template.unsupportedReason)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!state.list.complete && (
            <p className="text-xs text-muted-foreground">
              Only the first templates of this account are listed.
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setState({ step: "closed" })}
          >
            Cancel
          </Button>
        </div>
      )}
      {state.step === "form" && (
        <TemplateForm
          template={state.template}
          values={state.values}
          pending={pending}
          onChange={(key, value) =>
            setState({
              ...state,
              values: { ...state.values, [key]: value },
              draftId: newClientMessageId(),
            })
          }
          onSend={() => void send(state)}
          onBack={() => setState({ step: "list", list: state.list })}
        />
      )}
    </div>
  );
}
