"use client";

import { useMutation } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { CUSTOMER_NAME } from "@/lib/messaging/saved-replies";
import {
  BUTTON_TYPE_LABELS,
  builderIssues,
  KIND_HELP,
  KIND_LABELS,
  TEMPLATE_LIMITS,
  templateErrorNotice,
  toTemplateInput,
  type TemplateButton,
  type TemplateCard,
  type TemplateContent,
  type TemplateKind,
} from "@/lib/instagram/templates";
import { cn } from "@/lib/utils";
import { ConnectionNotice } from "../connections/connection-notice";
import { CHECKLIST, FORM_ACTIONS, PANEL_HEADER, PREVIEW_WELL } from "../library";
import { SECTION_HEADING, SURFACE } from "../surface";
import { TemplatePreview } from "./template-preview";
import { fieldClassName, Textarea } from "@/components/ui/textarea";

// Shared field look (components/ui/textarea.tsx).
const FIELD = fieldClassName;

/** A choice drawn as a card: the native radio, then its label. */
const OPTION =
  "flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-line bg-paper px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:border-line-strong has-[:checked]:border-primary/40 has-[:checked]:bg-blue-50/60";

export type TemplateDraft = { id?: string; name: string; content: TemplateContent };

const NEW_BUTTON: TemplateButton = { type: "reply", title: "" };
const NEW_CARD: TemplateCard = { title: "", subtitle: "", buttons: [] };

/** A switch to the other kind keeps what fits: the text becomes the first card's text. */
function switchKind(content: TemplateContent, kind: TemplateKind): TemplateContent {
  if (content.kind === kind) return content;
  if (content.kind === "buttons") {
    return {
      kind: "cards",
      cards: [
        {
          title: "",
          subtitle: content.text.slice(0, TEMPLATE_LIMITS.cardSubtitle),
          buttons: content.buttons.filter((b) => b.title.trim() !== ""),
        },
      ],
    };
  }
  const first = content.cards[0];
  return {
    kind: "buttons",
    text: first?.subtitle ?? first?.title ?? "",
    buttons: first !== undefined && first.buttons.length > 0 ? first.buttons : [NEW_BUTTON],
  };
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span
      className={cn("text-xs", value.length > max ? "text-destructive" : "text-muted-foreground")}
    >
      {value.length} / {max} characters
    </span>
  );
}

/** Up to 3 buttons, each opening a link or sending a reply. */
function ButtonsEditor({
  buttons,
  min,
  legend,
  onChange,
}: {
  buttons: TemplateButton[];
  min: number;
  legend: string;
  onChange: (buttons: TemplateButton[]) => void;
}) {
  const id = useId();
  const set = (i: number, button: TemplateButton) =>
    onChange(buttons.map((b, j) => (j === i ? button : b)));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {buttons.map((button, i) => (
        <div
          key={i}
          role="group"
          aria-label={`${legend}: button ${i + 1}`}
          className="flex flex-wrap items-end gap-2 rounded-[10px] border border-line bg-canvas/50 p-2.5"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-${i}-type`} className="text-xs">
              Button {i + 1}
            </Label>
            <select
              id={`${id}-${i}-type`}
              className={cn(FIELD, "w-40")}
              value={button.type}
              onChange={(e) =>
                set(
                  i,
                  e.target.value === "url"
                    ? { type: "url", title: button.title, url: "" }
                    : { type: "reply", title: button.title },
                )
              }
            >
              {(Object.keys(BUTTON_TYPE_LABELS) as TemplateButton["type"][]).map((type) => (
                <option key={type} value={type}>
                  {BUTTON_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-${i}-title`} className="text-xs">
              Label
            </Label>
            <Input
              id={`${id}-${i}-title`}
              className="w-44"
              value={button.title}
              maxLength={TEMPLATE_LIMITS.buttonTitle}
              onChange={(e) => set(i, { ...button, title: e.target.value })}
            />
          </div>
          {button.type === "url" && (
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <Label htmlFor={`${id}-${i}-url`} className="text-xs">
                Link
              </Label>
              <Input
                id={`${id}-${i}-url`}
                type="url"
                inputMode="url"
                placeholder="https://"
                value={button.url}
                maxLength={TEMPLATE_LIMITS.url}
                onChange={(e) => set(i, { ...button, url: e.target.value })}
              />
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Remove button ${i + 1}`}
            disabled={buttons.length <= min}
            onClick={() => onChange(buttons.filter((_, j) => j !== i))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      {buttons.length < TEMPLATE_LIMITS.buttons && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => onChange([...buttons, NEW_BUTTON])}
        >
          <Plus aria-hidden="true" />
          Add button
        </Button>
      )}
      <span className="text-xs text-muted-foreground">
        A reply button sends its label as the customer&apos;s message. Labels are 20 characters at
        most.
      </span>
    </fieldset>
  );
}

function CardEditor({
  card,
  index,
  count,
  onChange,
  onRemove,
}: {
  card: TemplateCard;
  index: number;
  count: number;
  onChange: (card: TemplateCard) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const n = index + 1;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-line bg-canvas/40 p-3">
      <legend className="px-1 text-sm font-medium text-ink">Card {n}</legend>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={card.title}
          maxLength={TEMPLATE_LIMITS.cardTitle}
          onChange={(e) => onChange({ ...card, title: e.target.value })}
        />
        <Counter value={card.title} max={TEMPLATE_LIMITS.cardTitle} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-subtitle`}>Text (optional)</Label>
        <Input
          id={`${id}-subtitle`}
          value={card.subtitle ?? ""}
          maxLength={TEMPLATE_LIMITS.cardSubtitle}
          onChange={(e) => onChange({ ...card, subtitle: e.target.value })}
        />
        <Counter value={card.subtitle ?? ""} max={TEMPLATE_LIMITS.cardSubtitle} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-image`}>Picture link (optional)</Label>
        <Input
          id={`${id}-image`}
          type="url"
          inputMode="url"
          placeholder="https://your-website.com/picture.jpg"
          value={card.imageUrl ?? ""}
          maxLength={TEMPLATE_LIMITS.url}
          onChange={(e) => onChange({ ...card, imageUrl: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">
          The https:// address of a picture on your website (JPG or PNG).
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-link`}>Opens when the card is tapped (optional)</Label>
        <Input
          id={`${id}-link`}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={card.linkUrl ?? ""}
          maxLength={TEMPLATE_LIMITS.url}
          onChange={(e) => onChange({ ...card, linkUrl: e.target.value })}
        />
      </div>
      <ButtonsEditor
        legend={`Card ${n} buttons (optional)`}
        buttons={card.buttons}
        min={0}
        onChange={(buttons) => onChange({ ...card, buttons })}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={count <= 1}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
        Remove card {n}
      </Button>
    </fieldset>
  );
}

/**
 * Creating or changing one Instagram template (editors and admins; ADR 0022): its name, kind
 * and content, with a live preview and what still needs doing before it can be saved.
 */
export function TemplateBuilder({
  initial,
  onDone,
  onCancel,
}: {
  initial: TemplateDraft;
  onDone: (notice: Notice) => void;
  onCancel: () => void;
}) {
  const create = useMutation(api.v1.instagramTemplates.create);
  const update = useMutation(api.v1.instagramTemplates.update);
  const [name, setName] = useState(initial.name);
  const [content, setContent] = useState<TemplateContent>(initial.content);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const id = useId();
  const issues = builderIssues(name, content);
  const editing = initial.id !== undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || issues.length > 0) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    const input = { name: name.trim(), content: toTemplateInput(content) };
    try {
      const saved =
        initial.id === undefined
          ? await create(input)
          : await update({ templateId: initial.id, ...input });
      onDone({
        tone: "success",
        title: editing ? "Template updated" : "Template added",
        message: `“${saved.name}” can now be sent from any Instagram conversation.`,
      });
    } catch (error) {
      setNotice(templateErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      aria-label={editing ? "Edit Instagram template" : "New Instagram template"}
      className={cn(SURFACE, "grid gap-5 p-4 md:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]")}
      onSubmit={(event) => void submit(event)}
    >
      <div className={cn(PANEL_HEADER, "lg:col-span-2")}>
        <h2 className={SECTION_HEADING}>
          {editing ? "Edit Instagram template" : "New Instagram template"}
        </h2>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {notice && <ConnectionNotice notice={notice} />}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={TEMPLATE_LIMITS.name}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">Only your team sees it.</span>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Kind</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(KIND_LABELS) as TemplateKind[]).map((kind) => (
              <label key={kind} className={OPTION}>
                <input
                  type="radio"
                  name={`${id}-kind`}
                  checked={content.kind === kind}
                  onChange={() => setContent((c) => switchKind(c, kind))}
                  className="size-4 shrink-0 accent-primary"
                />
                {KIND_LABELS[kind]}
              </label>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">{KIND_HELP[content.kind]}</span>
        </fieldset>
        {content.kind === "buttons" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-text`}>Message</Label>
              <Textarea
                id={`${id}-text`}
                rows={4}
                value={content.text}
                aria-invalid={content.text.length > TEMPLATE_LIMITS.text || undefined}
                onChange={(e) => setContent({ ...content, text: e.target.value })}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Counter value={content.text} max={TEMPLATE_LIMITS.text} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setContent({
                      ...content,
                      text: `${content.text}${content.text === "" || content.text.endsWith(" ") ? "" : " "}${CUSTOMER_NAME}`,
                    })
                  }
                >
                  Insert customer name
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {CUSTOMER_NAME} becomes the customer&apos;s first name when you send it.
              </span>
            </div>
            <ButtonsEditor
              legend="Buttons"
              buttons={content.buttons}
              min={1}
              onChange={(buttons) => setContent({ ...content, buttons })}
            />
          </>
        ) : (
          <div className="flex flex-col gap-3">
            {content.cards.map((card, i) => (
              <CardEditor
                key={i}
                card={card}
                index={i}
                count={content.cards.length}
                onChange={(next) =>
                  setContent({
                    kind: "cards",
                    cards: content.cards.map((c, j) => (j === i ? next : c)),
                  })
                }
                onRemove={() =>
                  setContent({ kind: "cards", cards: content.cards.filter((_, j) => j !== i) })
                }
              />
            ))}
            {content.cards.length < TEMPLATE_LIMITS.cards && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setContent({ kind: "cards", cards: [...content.cards, NEW_CARD] })}
              >
                <Plus aria-hidden="true" />
                Add card
              </Button>
            )}
          </div>
        )}
        {issues.length > 0 && (
          <div role="note" aria-label="Still to do" className={CHECKLIST}>
            <p className="font-medium text-amber-ink">Still to do before saving</p>
            <ul className="mt-1 list-disc pl-5 text-ink-2">
              {[...new Set(issues.map((issue) => issue.message))].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        <div className={FORM_ACTIONS}>
          <Button type="submit" disabled={pending || issues.length > 0}>
            {pending ? "Saving…" : "Save template"}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      <div className={PREVIEW_WELL}>
        <h3 className="text-sm font-medium text-ink">Preview</h3>
        <TemplatePreview content={content} />
        <p className="text-xs text-muted-foreground">
          Instagram shows buttons and cards in its phone and tablet apps, not on instagram.com.
        </p>
      </div>
    </form>
  );
}
