import {
  CircleDashed,
  Clapperboard,
  File,
  FileText,
  GalleryHorizontalEnd,
  ImageIcon,
  Play,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { SocialPost } from "@/lib/analytics/organic-types";

/** A glyph per post type: the organic UI never renders media from the platform. */
export const POST_TYPE_ICON: Record<SocialPost["type"], LucideIcon> = {
  image: ImageIcon,
  video: Video,
  reel: Clapperboard,
  carousel: GalleryHorizontalEnd,
  story: CircleDashed,
  text: FileText,
  other: File,
};

export const VIDEO_ICON = Play;

/** The decorative square in front of a post or video name (the type is also in text). */
export function MediaTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-line bg-canvas text-ink-2"
    >
      <Icon className="size-4" />
    </span>
  );
}
