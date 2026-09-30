import { ExternalLink } from "lucide-react";
import { safeInstagramPermalink } from "@/lib/analytics/permalink";
import { cn } from "@/lib/utils";

/**
 * "View on Instagram" for a post's validated permalink (the only URL the API returns). Opens a
 * new tab without handing the opener to Instagram; nothing renders without a safe permalink.
 */
export function InstagramLink({
  permalink,
  className,
}: {
  permalink: string | undefined;
  className?: string;
}) {
  const href = safeInstagramPermalink(permalink);
  if (href === undefined) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline",
        className,
      )}
    >
      View on Instagram
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
