import { ExternalLink, Phone, Reply } from "lucide-react";

export type PreviewButton = { type: string; text: string };

/**
 * How a template reads in WhatsApp: header, body, footer and its buttons under the message. Text
 * is shown as text (never as markup), variables as written or replaced by their samples.
 */
export function TemplatePreview({
  header,
  body,
  footer,
  buttons,
  label = "Message preview",
}: {
  header?: string;
  body: string;
  footer?: string;
  buttons: PreviewButton[];
  label?: string;
}) {
  return (
    <figure aria-label={label} className="flex w-full max-w-sm flex-col gap-1">
      <div className="rounded-[12px] rounded-tl-[4px] border border-line bg-paper px-3 py-2 text-sm text-ink shadow-soft">
        {header && <p className="mb-1 font-semibold break-words">{header}</p>}
        <p className="break-words whitespace-pre-wrap">
          {body || <span className="text-muted-foreground italic">The message body</span>}
        </p>
        {footer && <p className="mt-1 text-xs break-words text-muted-foreground">{footer}</p>}
      </div>
      {buttons.length > 0 && (
        <ul aria-label="Buttons" className="flex flex-col gap-1">
          {buttons.map((button, i) => (
            <li
              key={`${button.type}-${i}`}
              className="flex items-center justify-center gap-1.5 rounded-[10px] border border-line bg-paper px-3 py-1.5 text-sm font-medium text-blue-deep shadow-soft"
            >
              {button.type === "URL" ? (
                <ExternalLink aria-hidden="true" className="size-3.5" />
              ) : button.type === "PHONE_NUMBER" ? (
                <Phone aria-hidden="true" className="size-3.5" />
              ) : (
                <Reply aria-hidden="true" className="size-3.5" />
              )}
              {button.text || <span className="text-muted-foreground italic">Button label</span>}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
