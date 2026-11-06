/** The Gudz data surface: tables, charts and panels of the analytics pages. */
export const SURFACE = "rounded-[14px] border border-line bg-paper shadow-soft";

/** A section heading inside the analytics pages ("Over time", "Share of spend"). */
export const SECTION_HEADING = "text-[15px] font-medium text-ink";

/** Table padding at the surface edges: the first and last column sit 16 px in. */
export const TABLE_EDGES = "[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4";

/**
 * KPI cells on one surface, split by hairlines: each cell draws a 1 px outline into the 1 px
 * grid gap, so a last row that is not full stays blank instead of grey.
 */
export const KPI_STRIP =
  "grid gap-px overflow-hidden rounded-[14px] border border-line bg-paper shadow-soft";
export const KPI_CELL =
  "flex min-h-28 min-w-0 flex-col items-start gap-1.5 px-4 py-3.5 outline outline-line";
