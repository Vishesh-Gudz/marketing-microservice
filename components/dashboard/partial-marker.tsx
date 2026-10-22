/**
 * The partial-data marker after a value or a change: a visible asterisk, hidden from assistive
 * technology, and the words "(partial data)" for screen readers only. (An aria-label on a
 * role-less span is prohibited and not reliably announced.)
 */
export function PartialMarker({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span aria-hidden="true">*</span>
      <span className="sr-only"> (partial data)</span>
    </span>
  );
}
