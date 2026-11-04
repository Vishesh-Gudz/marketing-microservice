"use client";

import { useAction } from "convex/react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { cn } from "@/lib/utils";
import {
  addButton,
  builderFromStarter,
  builderIssues,
  emptyBuilder,
  LIMITS,
  newButton,
  normalizeTemplateName,
  sampleKeys,
  toDraft,
  urlHasVariable,
  withSamples,
  type BuilderButton,
  type BuilderState,
} from "@/lib/whatsapp/template-builder";
import { TEMPLATE_LANGUAGES } from "@/lib/whatsapp/template-languages";
import {
  CATEGORY_HELP,
  CATEGORY_LABELS,
  templateErrorNotice,
} from "@/lib/whatsapp/template-messages";
import {
  TEMPLATE_STARTERS,
  USE_CASE_LABELS,
  type StarterUseCase,
  type TemplateStarter,
} from "@/lib/whatsapp/template-starters";
import { ConnectionNotice } from "../connections/connection-notice";
import { TemplatePreview } from "./template-preview";

const FIELD =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20";

const BUTTON_TYPE_LABELS: Readonly<Record<BuilderButton["type"], string>> = {
  QUICK_REPLY: "Quick reply",
  URL: "Website link",
  PHONE_NUMBER: "Phone number",
};

function Counter({ id, value, max }: { id: string; value: string; max: number }) {
  return (
    <span
      id={id}
      className={cn("text-xs", value.length > max ? "text-destructive" : "text-muted-foreground")}
    >
      {value.length} / {max} characters
    </span>
  );
}

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Ready-made templates by use case; choosing one opens the form filled in. */
function StarterGallery({
  onChoose,
  onScratch,
}: {
  onChoose: (starter: TemplateStarter) => void;
  onScratch: () => void;
}) {
  const [useCase, setUseCase] = useState<StarterUseCase | "all">("all");
  const shown = TEMPLATE_STARTERS.filter((s) => useCase === "all" || s.useCase === useCase);
  return (
    <section aria-labelledby="starter-gallery" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="starter-gallery" className="font-semibold">
          Start from a ready-made template
        </h3>
        <Button type="button" variant="outline" size="sm" onClick={onScratch}>
          Start from scratch
        </Button>
      </div>
      <div role="group" aria-label="Use case" className="flex flex-wrap gap-2">
        {(["all", ...Object.keys(USE_CASE_LABELS)] as (StarterUseCase | "all")[]).map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={useCase === id ? "default" : "outline"}
            aria-pressed={useCase === id}
            onClick={() => setUseCase(id)}
          >
            {id === "all" ? "All" : USE_CASE_LABELS[id]}
          </Button>
        ))}
      </div>
      <ul aria-label="Ready-made templates" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((starter) => (
          <li
            key={starter.id}
            aria-labelledby={`starter-${starter.id}`}
            className="flex flex-col gap-3 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h4 id={`starter-${starter.id}`} className="font-medium">
                {starter.title}
              </h4>
              <Badge variant="outline">{CATEGORY_LABELS[starter.category]}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{starter.description}</p>
            <TemplatePreview
              label={`${starter.title} preview`}
              {...(starter.header !== undefined
                ? { header: fillStarter(starter.header, starter) }
                : {})}
              body={fillStarter(starter.body, starter)}
              buttons={starter.buttons}
            />
            <Button
              type="button"
              size="sm"
              className="mt-auto self-start"
              onClick={() => onChoose(starter)}
            >
              Use this template
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function fillStarter(text: string, starter: TemplateStarter): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (whole, name: string) => starter.samples[name] ?? whole);
}

/** One button of the form: its label and, for links and phone numbers, its target. */
function ButtonEditor({
  button,
  index,
  onChange,
  onRemove,
}: {
  button: BuilderButton;
  index: number;
  onChange: (button: BuilderButton) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const kind = BUTTON_TYPE_LABELS[button.type];
  return (
    <li
      aria-label={`Button ${index + 1}: ${kind}`}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{kind}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <Field label="Button label" htmlFor={`${id}-text`}>
        <Input
          id={`${id}-text`}
          value={button.text}
          maxLength={LIMITS.buttonText}
          onChange={(e) => onChange({ ...button, text: e.target.value })}
        />
      </Field>
      {button.type === "URL" && (
        <>
          <Field
            label="Website link"
            htmlFor={`${id}-url`}
            hint="Your own page. To add a value per message (an order number), end the link with {{1}}."
          >
            <Input
              id={`${id}-url`}
              value={button.url}
              inputMode="url"
              onChange={(e) => onChange({ ...button, url: e.target.value })}
            />
          </Field>
          {urlHasVariable(button.url) && (
            <Field label="Sample for the end of the link" htmlFor={`${id}-example`}>
              <Input
                id={`${id}-example`}
                value={button.example ?? ""}
                onChange={(e) => onChange({ ...button, example: e.target.value })}
              />
            </Field>
          )}
        </>
      )}
      {button.type === "PHONE_NUMBER" && (
        <Field
          label="Phone number"
          htmlFor={`${id}-phone`}
          hint="With + and the country code, for example +91 98765 43210."
        >
          <Input
            id={`${id}-phone`}
            value={button.phoneNumber}
            inputMode="tel"
            onChange={(e) => onChange({ ...button, phoneNumber: e.target.value })}
          />
        </Field>
      )}
    </li>
  );
}

/** The form: every part of the template, its samples and a live preview. */
function TemplateForm({
  accountId,
  initial,
  onBack,
  onSubmitted,
}: {
  accountId: string;
  initial: BuilderState;
  onBack: () => void;
  onSubmitted: (notice: Notice) => void;
}) {
  const createTemplate = useAction(api.v1.whatsapp.createTemplate);
  const [state, setState] = useState<BuilderState>(initial);
  const [variable, setVariable] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const id = useId();
  const issues = builderIssues(state);
  const samples = sampleKeys(state);
  const set = (patch: Partial<BuilderState>) => setState((s) => ({ ...s, ...patch }));
  const count = (type: BuilderButton["type"]) =>
    state.buttons.filter((b) => b.type === type).length;
  const full = state.buttons.length >= LIMITS.buttons;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || issues.length > 0) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    try {
      const created = await createTemplate({ accountId, draft: toDraft(state) });
      onSubmitted({
        tone: "success",
        title: "Template submitted for review",
        message: `Meta is reviewing “${created.name}”. Review usually takes a few minutes and can take up to 24 hours; it can be sent once approved.`,
      });
    } catch (error) {
      setNotice(templateErrorNotice(error, "create"));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const variableName = normalizeTemplateName(variable).replace(/^[^a-z]+/, "");
  return (
    <form
      aria-label="New template"
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
      onSubmit={(event) => void submit(event)}
    >
      <div className="flex flex-col gap-5">
        {notice && <ConnectionNotice notice={notice} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Template name"
            htmlFor={`${id}-name`}
            hint="Lowercase letters, numbers and underscores. Customers never see it."
          >
            <Input
              id={`${id}-name`}
              value={state.name}
              onChange={(e) => set({ name: normalizeTemplateName(e.target.value) })}
            />
          </Field>
          <Field
            label="Language"
            htmlFor={`${id}-language`}
            hint="Write the text in this language."
          >
            <select
              id={`${id}-language`}
              className={FIELD}
              value={state.language}
              onChange={(e) => set({ language: e.target.value })}
            >
              {TEMPLATE_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Category</legend>
          {(["UTILITY", "MARKETING"] as const).map((category) => (
            <label key={category} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-category`}
                value={category}
                checked={state.category === category}
                onChange={() => set({ category })}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{CATEGORY_LABELS[category]}</span>
                <span className="block text-muted-foreground">{CATEGORY_HELP[category]}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Meta decides the final category during review, and prices messages by it.
          </p>
        </fieldset>

        <Field
          label="Header (optional)"
          htmlFor={`${id}-header`}
          hint={<Counter id={`${id}-header-count`} value={state.header} max={LIMITS.header} />}
        >
          <Input
            id={`${id}-header`}
            value={state.header}
            aria-describedby={`${id}-header-count`}
            onChange={(e) => set({ header: e.target.value })}
          />
        </Field>

        <Field
          label="Message body"
          htmlFor={`${id}-body`}
          hint={
            <div className="flex flex-col gap-1">
              <Counter id={`${id}-body-count`} value={state.body} max={LIMITS.body} />
              <span>
                Variables such as {"{{customer_name}}"} are filled in for each customer. Keep them
                inside a sentence, not at the very start or end, and never two side by side.
              </span>
            </div>
          }
        >
          <textarea
            id={`${id}-body`}
            rows={6}
            className={FIELD}
            value={state.body}
            aria-describedby={`${id}-body-count`}
            onChange={(e) => set({ body: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a variable" htmlFor={`${id}-variable`}>
            <Input
              id={`${id}-variable`}
              value={variable}
              placeholder="order_number"
              onChange={(e) => setVariable(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={variableName === ""}
            onClick={() => {
              const spacer = state.body === "" || state.body.endsWith(" ") ? "" : " ";
              set({ body: `${state.body}${spacer}{{${variableName}}}` });
              setVariable("");
            }}
          >
            Insert into body
          </Button>
        </div>

        <Field
          label="Footer (optional)"
          htmlFor={`${id}-footer`}
          hint={<Counter id={`${id}-footer-count`} value={state.footer} max={LIMITS.footer} />}
        >
          <Input
            id={`${id}-footer`}
            value={state.footer}
            aria-describedby={`${id}-footer-count`}
            onChange={(e) => set({ footer: e.target.value })}
          />
        </Field>

        <section aria-labelledby={`${id}-buttons`} className="flex flex-col gap-3">
          <h4 id={`${id}-buttons`} className="text-sm font-medium">
            Buttons (optional)
          </h4>
          {state.buttons.length > 0 && (
            <ul className="flex flex-col gap-2">
              {state.buttons.map((button, index) => (
                <ButtonEditor
                  key={button.key}
                  button={button}
                  index={index}
                  onChange={(next) =>
                    set({ buttons: state.buttons.map((b) => (b.key === button.key ? next : b)) })
                  }
                  onRemove={() =>
                    set({ buttons: state.buttons.filter((b) => b.key !== button.key) })
                  }
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={full || count("QUICK_REPLY") >= LIMITS.quickReplies}
              onClick={() => set({ buttons: addButton(state.buttons, newButton("QUICK_REPLY")) })}
            >
              Add quick reply
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={full || count("URL") >= LIMITS.urlButtons}
              onClick={() => set({ buttons: addButton(state.buttons, newButton("URL")) })}
            >
              Add website link
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={full || count("PHONE_NUMBER") >= LIMITS.phoneButtons}
              onClick={() => set({ buttons: addButton(state.buttons, newButton("PHONE_NUMBER")) })}
            >
              Add phone number
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Up to 10 quick replies, 2 website links and 1 phone number. Quick replies come first.
          </p>
        </section>

        {samples.length > 0 && (
          <section aria-labelledby={`${id}-samples`} className="flex flex-col gap-3">
            <h4 id={`${id}-samples`} className="text-sm font-medium">
              Sample values
            </h4>
            <p className="text-xs text-muted-foreground">
              Meta reviews the template with these examples; customers see your real values.
            </p>
            {samples.map((sample) => {
              const [component, name] = sample.split(".");
              return (
                <Field
                  key={sample}
                  label={`{{${name}}} in the ${component}`}
                  htmlFor={`${id}-sample-${sample}`}
                >
                  <Input
                    id={`${id}-sample-${sample}`}
                    value={state.samples[sample] ?? ""}
                    maxLength={LIMITS.example}
                    onChange={(e) =>
                      set({ samples: { ...state.samples, [sample]: e.target.value } })
                    }
                  />
                </Field>
              );
            })}
          </section>
        )}

        {issues.length > 0 && (
          <div
            role="note"
            aria-label="Still to do"
            className="rounded-md border border-dashed p-3 text-sm"
          >
            <p className="font-medium">Before submitting</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {[...new Set(issues.map((issue) => issue.message))].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending || issues.length > 0}>
            {pending ? "Submitting…" : "Submit for review"}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
      <aside aria-label="Preview" className="flex flex-col gap-2 lg:sticky lg:top-4 lg:self-start">
        <p className="text-sm font-medium">Preview</p>
        <TemplatePreview
          {...(state.header.trim() !== ""
            ? { header: withSamples(state.header, "header", state.samples) }
            : {})}
          body={withSamples(state.body, "body", state.samples)}
          {...(state.footer.trim() !== "" ? { footer: state.footer } : {})}
          buttons={state.buttons}
        />
      </aside>
    </form>
  );
}

/**
 * Creating a template (admins; ADR 0020): a gallery of ready-made templates, or a blank one,
 * then the form. Submitting sends it to Meta for review (v1/whatsapp:createTemplate).
 */
export function TemplateBuilder({
  accountId,
  onDone,
  onCancel,
}: {
  accountId: string;
  onDone: (notice: Notice) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<BuilderState | null>(null);
  return (
    <section aria-labelledby="new-template" className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="new-template" className="text-lg font-semibold">
          New template
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {draft === null ? (
        <StarterGallery
          onChoose={(starter) => setDraft(builderFromStarter(starter))}
          onScratch={() => setDraft(emptyBuilder())}
        />
      ) : (
        <TemplateForm
          accountId={accountId}
          initial={draft}
          onBack={() => setDraft(null)}
          onSubmitted={onDone}
        />
      )}
    </section>
  );
}
