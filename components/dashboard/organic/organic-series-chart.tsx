"use client";

import { useId, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
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
import { DATA_STATE_LABEL } from "@/lib/analytics/states";
import { EmptyState } from "../empty-state";

type DotProps = { cx?: number; cy?: number; index?: number; payload?: PlotRow };

function CompleteDot({ cx, cy, index, payload }: DotProps) {
  if (cx === undefined || cy === undefined || payload?.solid == null) return <g key={index} />;
  return <circle key={index} cx={cx} cy={cy} r={3} fill="var(--color-value)" />;
}

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

export type SeriesGranularity = "day" | "week" | "month";

/**
 * A line of API values over UTC days (organic account series) or UTC capture days (post
 * lifetime totals). Gaps are honest (null = no value; never interpolated, never 0), partial
 * buckets are dashed with hollow points, and every chart has an equivalent table view.
 */
export function OrganicSeriesChart<M extends string>({
  title,
  heading,
  rows,
  granularity,
  metric,
  metrics,
  onMetricChange,
  dayOnly = false,
  note,
}: {
  title: string;
  /** Accessible chart name, e.g. "Views by day (UTC)". */
  heading: string;
  rows: readonly ChartRow[];
  granularity: SeriesGranularity;
  metric: M;
  metrics: readonly { value: M; label: string }[];
  onMetricChange: (metric: M) => void;
  /** The API reports the metric only per single day (non-additive). */
  dayOnly?: boolean;
  note: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  const label = metrics.find((m) => m.value === metric)?.label ?? metric;
  const config = { value: { label, color: "var(--chart-1)" } } satisfies ChartConfig;
  const plotted = rows.some((row) => row.value !== null);
  const period = (row: ChartRow) =>
    granularity === "day" || row.from === row.to ? row.from : `${row.from} – ${row.to}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        <div className="flex items-center gap-2">
          <Select
            value={metric}
            onValueChange={(value) => {
              const next = metrics.find((m) => m.value === value);
              if (next) onMetricChange(next.value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Chart metric" className="w-48">
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

      {dayOnly ? (
        <EmptyState title={`${label} is only available per day`}>
          Instagram counts unique accounts for this metric, so its daily values cannot be added up
          into weeks or months. Set the interval to Day to see it.
        </EmptyState>
      ) : asTable ? (
        <div className="max-h-96 overflow-auto rounded-md border">
          <Table>
            <TableCaption className="sr-only">{heading}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Period (UTC)</TableHead>
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
        <EmptyState title="Nothing to chart for this range">
          No period in the range has a value for {label.toLowerCase()}. Missing values are never
          drawn as zero.
        </EmptyState>
      ) : (
        <figure>
          <ChartContainer
            config={config}
            className="aspect-auto h-72 w-full"
            role="img"
            aria-label={heading}
          >
            <LineChart data={plotRows(rows)} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tickFormatter={(bucket: string) => bucketLabel(bucket, granularity)}
              />
              <YAxis tickLine={false} axisLine={false} width={64} />
              <ChartTooltip
                content={(props) => {
                  const row = (
                    props.payload as ReadonlyArray<{ payload?: PlotRow }> | undefined
                  )?.[0]?.payload;
                  if (!props.active || !row) return null;
                  return (
                    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
                      <p className="font-medium">{period(row)} (UTC)</p>
                      <p className="tabular-nums">
                        {label}: {row.display}
                      </p>
                      <p className="text-muted-foreground">{DATA_STATE_LABEL[row.dataState]}</p>
                    </div>
                  );
                }}
              />
              <Line
                dataKey="solid"
                type="linear"
                stroke="var(--color-value)"
                strokeWidth={2}
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
            </LineChart>
          </ChartContainer>
          <figcaption className="mt-1 text-xs text-muted-foreground">{note}</figcaption>
        </figure>
      )}
    </section>
  );
}
