"use client";

import Link from "next/link";
import { filterParamsOnly } from "@/lib/analytics/filters";
import type { SocialPlatformView } from "@/lib/analytics/organic-filters";
import { cn } from "@/lib/utils";

const PLATFORMS: readonly { platform: SocialPlatformView; label: string }[] = [
  { platform: "instagram", label: "Instagram" },
  { platform: "youtube", label: "YouTube" },
];

/** The /social link for a platform: the global filters are kept, the account is not. */
export function socialPlatformHref(platform: SocialPlatformView, current: URLSearchParams): string {
  const params = filterParamsOnly(current);
  if (platform === "youtube") params.set("platform", "youtube");
  const query = params.toString();
  return query ? `/social?${query}` : "/social";
}

/**
 * Instagram | YouTube on /social (ADR 0016, Checkpoint 5). Two separate views of separate
 * data: switching never combines the platforms. Links (not tabs), so the choice is in the URL.
 */
export function SocialPlatformSwitch({
  current,
  searchParams,
}: {
  current: SocialPlatformView;
  searchParams: URLSearchParams;
}) {
  return (
    <nav aria-label="Organic platform" data-testid="social-platform-switch">
      <ul className="inline-flex rounded-md border p-0.5">
        {PLATFORMS.map(({ platform, label }) => {
          const active = platform === current;
          return (
            <li key={platform}>
              <Link
                href={socialPlatformHref(platform, searchParams)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-sm px-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
