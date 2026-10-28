import { ExternalLink } from "lucide-react";
import { safeYouTubeWatchUrl } from "@/lib/analytics/permalink";
import { cn } from "@/lib/utils";

/**
 * "Watch on YouTube" for a video's validated watch URL (the only URL the API returns). Opens a
 * new tab without handing the opener to YouTube; nothing renders without a safe URL.
 */
export function YouTubeLink({
  permalink,
  title,
  className,
}: {
  permalink: string | undefined;
  /** The video's title, for the link's accessible name. */
  title: string;
  className?: string;
}) {
  const href = safeYouTubeWatchUrl(permalink);
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
      Watch on YouTube
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only">: {title} (opens in a new tab)</span>
    </a>
  );
}
