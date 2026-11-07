import { ExternalLink, ImageIcon, Reply } from "lucide-react";
import { urlHost, type TemplateButton, type TemplateContent } from "@/lib/instagram/templates";
import { cn } from "@/lib/utils";

function Buttons({ buttons, label }: { buttons: TemplateButton[]; label: string }) {
  if (buttons.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line border-t border-line">
      {buttons.map((button, i) => (
        <li
          key={`${button.type}-${i}`}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-deep"
        >
          {button.type === "url" ? (
            <ExternalLink aria-hidden="true" className="size-3.5" />
          ) : (
            <Reply aria-hidden="true" className="size-3.5" />
          )}
          {button.title || <span className="text-muted-foreground italic">Button label</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * How an Instagram template reads in the Instagram app (ADR 0022): a button message, or cards
 * side by side. Text is shown as text (never as markup). Pictures are never loaded here: a card
 * shows where its picture comes from.
 */
export function TemplatePreview({
  content,
  label = "Message preview",
  className,
}: {
  content: TemplateContent;
  label?: string;
  className?: string;
}) {
  if (content.kind === "buttons") {
    return (
      <figure
        aria-label={label}
        className={cn(
          "flex w-full max-w-xs flex-col overflow-hidden rounded-[12px] border border-line bg-paper text-ink shadow-soft",
          className,
        )}
      >
        <p className="px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {content.text || <span className="text-muted-foreground italic">The message</span>}
        </p>
        <Buttons buttons={content.buttons} label="Buttons" />
      </figure>
    );
  }
  return (
    <figure aria-label={label} className={cn("flex w-full max-w-full", className)}>
      <ul aria-label="Cards" className="flex gap-2 overflow-x-auto pb-1">
        {content.cards.map((card, i) => {
          const host = card.imageUrl ? urlHost(card.imageUrl) : undefined;
          return (
            <li
              key={i}
              aria-label={`Card ${i + 1}`}
              className="flex w-56 shrink-0 flex-col overflow-hidden rounded-[12px] border border-line bg-paper text-ink shadow-soft"
            >
              {card.imageUrl && (
                <div className="flex h-24 items-center justify-center gap-1.5 bg-canvas px-2 text-xs text-muted-foreground">
                  <ImageIcon aria-hidden="true" className="size-4" />
                  <span className="truncate">{host ? `Picture from ${host}` : "Picture"}</span>
                </div>
              )}
              <div className="flex flex-col gap-0.5 px-3 py-2">
                <p className="text-sm font-semibold break-words">
                  {card.title || <span className="text-muted-foreground italic">Card title</span>}
                </p>
                {card.subtitle && (
                  <p className="text-xs break-words text-muted-foreground">{card.subtitle}</p>
                )}
                {card.linkUrl && urlHost(card.linkUrl) && (
                  <p className="truncate text-xs text-muted-foreground">
                    Opens {urlHost(card.linkUrl)}
                  </p>
                )}
              </div>
              <div className="mt-auto">
                <Buttons buttons={card.buttons} label={`Card ${i + 1} buttons`} />
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
