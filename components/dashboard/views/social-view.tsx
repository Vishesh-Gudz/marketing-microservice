"use client";

import { parseSocialParams } from "@/lib/analytics/organic-filters";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { SocialPlatformSwitch } from "../organic/social-platform-switch";
import { OrganicView } from "./organic-view";
import { YouTubeView } from "./youtube-view";

/**
 * /social: the Instagram view (the original page, the default) or, with `platform=youtube`,
 * the YouTube view (ADR 0016). The two never share or combine data.
 */
export function SocialView() {
  const { searchParams } = useDashboardFilters();
  const params = new URLSearchParams(searchParams.toString());
  const { platform } = parseSocialParams(params);
  const switcher = <SocialPlatformSwitch current={platform} searchParams={params} />;
  return platform === "youtube" ? (
    <YouTubeView switcher={switcher} />
  ) : (
    <OrganicView switcher={switcher} />
  );
}
