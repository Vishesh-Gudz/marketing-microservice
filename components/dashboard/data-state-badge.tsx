import { Badge } from "@/components/ui/badge";
import { DATA_STATE_DESCRIPTION, DATA_STATE_LABEL } from "@/lib/analytics/states";
import type { DataState } from "@/lib/analytics/types";

/** Explicit data state (D10). "reported" is the normal case and is not badged unless asked. */
export function DataStateBadge({
  state,
  showReported = false,
}: {
  state: DataState;
  showReported?: boolean;
}) {
  if (state === "reported" && !showReported) return null;
  const variant = state === "partial" || state === "unknown" ? "outline" : "secondary";
  return (
    <Badge variant={variant} title={DATA_STATE_DESCRIPTION[state]} data-state-badge={state}>
      {DATA_STATE_LABEL[state]}
    </Badge>
  );
}
