import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SECTION_HEADING, SURFACE } from "./surface";

// The visual parts of the library and settings pages (saved replies, both template libraries,
// WhatsApp and Instagram DM settings, Connections). Each page keeps its own queries, roles,
// confirmations and send or save logic, and only uses these frames and classes.

/** One item of a library or settings list: a saved reply, a template, an account. */
export const CARD = cn(SURFACE, "flex min-w-0 flex-col gap-3 p-4");

/** A card's actions, on a hairline at its foot. */
export const CARD_ACTIONS = "mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3";

/** Blocks stacked inside a card, split by hairlines (status, then account choice, then links). */
export const CARD_SECTIONS =
  "flex min-w-0 flex-col gap-5 [&>*+*]:border-t [&>*+*]:border-line [&>*+*]:pt-5";

/** A sub-section heading inside a card ("Linked accounts"). */
export const SUB_HEADING = "text-sm font-medium text-ink";

/** A bordered table or row list inside a card. */
export const INNER_TABLE = "overflow-x-auto rounded-[10px] border border-line";

/** An editor opened on the page (a saved-reply form, a template builder). */
export const PANEL = cn(SURFACE, "flex min-w-0 flex-col gap-5 p-4 md:p-5");

/** The title row of a panel, on a hairline. */
export const PANEL_HEADER =
  "flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3";

/** The save / cancel row at a form's foot. */
export const FORM_ACTIONS = "flex flex-wrap items-center gap-2 border-t border-line pt-4";

/** Ready-made items, on a tinted well so their cards stand out. */
export const GALLERY = "flex flex-col gap-4 rounded-[14px] border border-line bg-canvas/60 p-4";

/** A group heading inside a gallery ("Opening hours", "Orders"). */
export const GROUP_HEADING = "text-[13px] font-medium text-ink-2";

/** A small rounded label: a quick-reply button title, an ice breaker. */
export const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs text-ink";

/** A nested block inside a card or form (a button editor, the ice breakers). */
export const INSET =
  "flex min-w-0 flex-col gap-2 rounded-[10px] border border-line bg-canvas/50 p-3";

/** What is still missing before a form can be submitted. */
export const CHECKLIST = "rounded-[10px] border border-amber-line bg-amber-tint/60 p-3 text-sm";

/** The backdrop of a live preview, kept in view beside a long form. */
export const PREVIEW_WELL =
  "flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-canvas/70 p-4 lg:sticky lg:top-4 lg:self-start";

/** The backdrop of a preview inside a card, so the message reads as a message. */
export const PREVIEW_INSET = "flex min-w-0 rounded-[10px] bg-canvas/70 p-3";

/** A segmented row of toggle buttons (`aria-pressed`), like the inbox channel filter. */
export const SEGMENTED =
  "inline-flex max-w-full flex-wrap gap-0.5 rounded-[10px] border border-line bg-canvas p-0.5";
export const SEGMENT =
  "inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-sm font-medium text-ink-2 transition-colors outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-paper aria-pressed:text-ink aria-pressed:shadow-soft";

/** A page section's title row: the heading, and controls at its right. */
export function SectionHeader({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={id} className={SECTION_HEADING}>
        {title}
      </h2>
      {children}
    </div>
  );
}

export type StatusTone = "ok" | "neutral" | "warning" | "danger";

const STATUS_TONES: Readonly<Record<StatusTone, string>> = {
  ok: "bg-ok-tint text-ok-ink",
  neutral: "bg-canvas text-ink-2",
  warning: "border-amber-line bg-amber-tint text-amber-ink",
  danger: "border-danger-line bg-danger-tint text-danger-ink",
};

/** A status in words, tinted by how it stands (never colour alone: the label says it). */
export function StatusTag({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <Badge variant="secondary" className={STATUS_TONES[tone]}>
      {children}
    </Badge>
  );
}

/**
 * A channel or settings card: an icon, the heading (the section's name) and a line on what it
 * is for, then its content. `id` names the section for assistive technology.
 */
export function ChannelCard({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  /** A Lucide icon or an integration's colour logo. */
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cn(SURFACE, "flex min-w-0 flex-col")}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3.5 md:px-5">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-[12px] border border-line bg-paper text-ink-2 shadow-soft"
        >
          <Icon className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 id={id} className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </header>
      <div className="flex min-w-0 flex-col p-4 md:p-5">{children}</div>
    </section>
  );
}

/**
 * Focus for an inline confirmation: the safe choice (Cancel) when it opens, and back to the
 * button that opened it when it closes. Attach `triggerRef` to that button and `cancelRef` to
 * Cancel.
 */
export function useConfirmFocus(confirming: boolean) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (opened.current) triggerRef.current?.focus();
    opened.current = confirming;
  }, [confirming]);
  return { triggerRef, cancelRef };
}

/**
 * The look of every inline confirmation (delete, disconnect, turn off): a tinted panel with the
 * question, what will happen, and the buttons. Escape cancels unless the action is running.
 * Each caller keeps its own state, focus handling and in-flight guard.
 */
export function ConfirmPanel({
  titleId,
  title,
  label,
  consequences,
  onCancel,
  pending,
  children,
}: {
  /** The question's id; names the group unless `label` is given. */
  titleId?: string;
  title: ReactNode;
  /** An explicit accessible name, when it differs from the visible question. */
  label?: string;
  consequences?: readonly ReactNode[];
  onCancel: () => void;
  pending: boolean;
  /** The buttons: the action, then Cancel. */
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      {...(label !== undefined ? { "aria-label": label } : { "aria-labelledby": titleId })}
      className="flex w-full flex-col gap-3 rounded-[10px] border border-danger-line bg-danger-tint/50 p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onCancel();
      }}
    >
      <p id={titleId} className="font-medium text-ink">
        {title}
      </p>
      {consequences !== undefined && consequences.length > 0 && (
        <ul className="list-disc pl-5 text-ink-2">
          {consequences.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
