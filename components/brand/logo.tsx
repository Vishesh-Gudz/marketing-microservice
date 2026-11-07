// The Gudz logo from gudz-landing @ redesign-2026 (components/logo.tsx). Its paths are kept
// unchanged in gudz-logo.svg (the brand source of truth; do not redraw or simplify them) and
// shown as an image: the path data is large, and as an inline SVG it was part of every page's
// JavaScript. The browser now loads it once and caches it.
import { cn } from "@/lib/utils";
import logo from "./gudz-logo.svg";

/** Next resolves the import to image data; plain bundlers (the unit tests) to its URL. */
const SRC: string = typeof logo === "string" ? logo : (logo as { src: string }).src;

/** The logo in the Gudz blue. Size it with classes (e.g. `h-[18px] w-auto`). */
export function Logo({
  className,
  label,
}: {
  className?: string;
  /** The image's text; leave out where the name is already written next to it. */
  label?: string;
}) {
  return (
    // A plain image on purpose: next/image does not optimize SVG, and its client code would
    // cost more than it saves here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={SRC}
      alt={label ?? ""}
      width={150}
      height={40}
      decoding="async"
      className={cn("shrink-0", className)}
    />
  );
}
