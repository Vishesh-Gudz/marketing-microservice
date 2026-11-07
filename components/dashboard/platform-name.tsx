import { ChannelLogo, isChannelLogoName } from "@/components/brand/channel-logo";
import { humanize } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

/**
 * A platform's name with its colour logo in front ("Google Ads", "Meta", "YouTube"). Platforms
 * without a logo (an unknown value) are shown as their name only.
 */
export function PlatformName({ platform, className }: { platform: string; className?: string }) {
  const name = humanize(platform);
  if (!isChannelLogoName(platform)) return <span className={className}>{name}</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <ChannelLogo channel={platform} className="size-3.5" />
      {name}
    </span>
  );
}
