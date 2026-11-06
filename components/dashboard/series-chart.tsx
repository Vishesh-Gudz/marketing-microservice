"use client";

import { useId, useState, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bucketLabel, plotRows, type ChartRow, type PlotRow } from "@/lib/analytics/chart-data";
import type { Granularity } from "@/lib/analytics/filters";
import { DATA_STATE_LABEL } from "@/lib/analytics/states";
import { EmptyState } from "./empty-state";
import { SECTION_HEADING, TABLE_EDGES } from "./surface";

type DotProps = { cx?: number; cy?: number; index?: number; payload?: PlotRow };

/** Filled dots on the solid line (complete buckets). */
function CompleteDot({ cx, cy, index, payload }: DotProps) {
  if (cx === undefined || cy === undefined || payload?.solid == null) return <g key={index} />;
  return <circle key={index} cx={cx} cy={cy} r={3} fill="var(--color-value)" />;
}

/** Hollow dots on the dashed line, only at incomplete buckets. */
function IncompleteDot({ cx, cy, index, payload }: DotProps) {
  if (cx === undefined || cy === undefined || payload?.dashed == null || !payload.incomplete) {
    return <g key={index} />;
  }
  return (
    <circle
      key={index}
      cx={cx}
      cy={cy}
      r={3.5}
      strokeWidth={1.5}
      stroke="var(--color-value)"
      fill="var(--background)"
    />
  );
}

/**
 * One metric over time, shared by the paid and the organic charts (D6): a brand area line on a
 * dashed grid with compact y labels. Gaps are honest (null = no value, never interpolated),
 * partial buckets are dashed with hollow points, and every chart has an equivalent table view.
 * The rows, labels and notes come from the caller; this component computes no value.
 */
export function SeriesChart<M extends string>({
  title,
  heading,
  rows,
  granularity,
  metric,
  metrics,
  onMetricChange,
  tick,
  tooltip,
  period,
  periodHeader = "Period",
  unavailable,
  nothingToChart,
  note,
  aside,
}: {
  title: string;
  /** Accessible chart name and table caption, e.g. "Spend (USD) by day". */
  heading: string;
  rows: readonly ChartRow[];
  granularity: Granularity;
  metric: M;
  metrics: readonly { value: M; label: string }[];
  onMetricChange: (metric: M) => void;
  /** The y-axis label of a tick value. */
  tick: (value: number) => string;
  /** The tooltip lines of one bucket. */
  tooltip: (row: PlotRow) => ReactNode;
  /** A bucket's period, as the table and tooltip show it. */
  period: (row: ChartRow) => string;
  periodHeader?: string;
  /** Shown instead of the chart and its table when the metric cannot be charted. */
  unavailable?: ReactNode;
  /** The text of "Nothing to chart for this range". */
  nothingToChart: ReactNode;
  note: ReactNode;
  /** Shown next to the title, e.g. the series' data state. */
  aside?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  // SVG ids cannot hold the colons of React ids inside url(#…).
  const fillId = `fill-${headingId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const label = metrics.find((option) => option.value === metric)?.label ?? metric;
  const config = { value: { label, color: "var(--chart-1)" } } satisfies ChartConfig;
  const plotted = rows.some((row) => row.value !== null);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={headingId} className={SECTION_HEADING}>
            {title}
          </h2>
          {aside}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={metric}
            onValueChange={(value) => {
              const next = metrics.find((option) => option.value === value);
              if (next) onMetricChange(next.value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Chart metric" className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metrics.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={asTable}
            onClick={() => setAsTable((value) => !value)}
          >
            {asTable ? "View as chart" : "View as table"}
          </Button>
        </div>
      </div>

      {unavailable ? (
        unavailable
      ) : asTable ? (
        <div className="max-h-96 overflow-auto rounded-[10px] border border-line">
          <Table className={TABLE_EDGES}>
            <TableCaption className="sr-only">{heading}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{periodHeader}</TableHead>
                <TableHead scope="col" className="text-right">
                  {label}
                </TableHead>
                <TableHead scope="col">Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.bucket}>
                  <TableCell>{period(row)}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.display}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {DATA_STATE_LABEL[row.dataState]}
                    {row.incomplete && row.dataState !== "partial" ? " (partial bucket)" : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : !plotted ? (
        <EmptyState title="Nothing to chart for this range">{nothingToChart}</EmptyState>
      ) : (
        <figure>
          <ChartContainer
            config={config}
            className="aspect-auto h-72 w-full"
            role="img"
            aria-label={heading}
          >
            <ComposedChart data={plotRows(rows)} margin={{ left: 0, right: 8, top: 8 }}>
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.16} />
                  <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-line)" />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tickMargin={8}
                tickFormatter={(bucket: string) => bucketLabel(bucket, granularity)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value: number) => tick(value)}
              />
              <ChartTooltip
                content={(props) => {
                  const row = (
                    props.payload as ReadonlyArray<{ payload?: PlotRow }> | undefined
                  )?.[0]?.payload;
                  if (!props.active || !row) return null;
                  return (
                    <div className="grid gap-1 rounded-[10px] border border-line bg-paper px-3 py-2 text-xs shadow-lift">
                      {tooltip(row)}
                    </div>
                  );
                }}
              />
              <Area
                dataKey="solid"
                type="linear"
                stroke="var(--color-value)"
                strokeWidth={2}
                fill={`url(#${fillId})`}
                connectNulls={false}
                dot={(props) => <CompleteDot {...(props as DotProps)} />}
                isAnimationActive={false}
              />
              <Line
                dataKey="dashed"
                type="linear"
                stroke="var(--color-value)"
                strokeWidth={2}
                strokeDasharray="4 4"
                connectNulls={false}
                dot={(props) => <IncompleteDot {...(props as DotProps)} />}
                activeDot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ChartContainer>
          <figcaption className="mt-1 text-xs text-muted-foreground">{note}</figcaption>
        </figure>
      )}
    </section>
  );
}
