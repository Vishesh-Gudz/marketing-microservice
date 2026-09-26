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
import {
  bucketLabel,
  buildSeries,
  CHART_METRICS,
  isChartMetric,
  plotRows,
  type ChartMetric,
  type PlotRow,
} from "@/lib/analytics/chart-data";
import type { Granularity } from "@/lib/analytics/filters";
import { DATA_STATE_LABEL } from "@/lib/analytics/states";
import type { TimeSeriesPoint } from "@/lib/analytics/types";
import { VALUES } from "@/lib/analytics/values";
import { EmptyState } from "./empty-state";

const GRANULARITY_LABEL: Record<Granularity, string> = { day: "Day", week: "Week", month: "Month" };

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

function TooltipBody({
  active,
  payload,
  granularity,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  granularity: Granularity;
}) {
  const row = payload?.[0]?.payload as PlotRow | undefined;
  if (!active || !row) return null;
  return (
    <div className="grid gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {granularity === "day" ? row.from : `${row.from} – ${row.to}`}
      </div>
      <div className="tabular-nums">{row.display}</div>
      {row.dataState !== "reported" && (
        <div className="text-muted-foreground">{DATA_STATE_LABEL[row.dataState]}</div>
      )}
      {row.dataState === "no_delivery" && (
        <div className="text-muted-foreground">Plotted as 0 (nothing delivered)</div>
      )}
      {row.incomplete && <div className="text-muted-foreground">Partial bucket</div>}
    </div>
  );
}

/**
 * Metric over time (D6). Unsynced buckets are gaps (connectNulls=false), buckets
 * without delivery are 0, partial buckets are drawn dashed with hollow points,
 * and every chart has an equivalent table view.
 */
export function TimeSeriesChart({
  points,
  granularity,
  reportingCurrency,
  metric,
  onMetricChange,
  title = "Over time",
}: {
  points: readonly TimeSeriesPoint[];
  granularity: Granularity;
  reportingCurrency: string;
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
  title?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  const series = buildSeries(points, metric, reportingCurrency);
  const label = VALUES[metric].label;
  const config = { value: { label, color: "var(--chart-1)" } } satisfies ChartConfig;
  const plotted = series.available && series.rows.some((row) => row.value !== null);
  const heading = `${label}${series.available && series.currency ? ` (${series.currency})` : ""} by ${GRANULARITY_LABEL[granularity].toLowerCase()}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        <div className="flex items-center gap-2">
          <Select
            value={metric}
            onValueChange={(value) => isChartMetric(value) && onMetricChange(value)}
          >
            <SelectTrigger size="sm" aria-label="Chart metric" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHART_METRICS.map((key) => (
                <SelectItem key={key} value={key}>
                  {VALUES[key].label}
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

      {!series.available ? (
        <EmptyState title="This metric cannot be charted in one currency">
          The accounts use different currencies and exchange rates are missing, so their amounts
          cannot be combined. Filter to accounts with one currency or add exchange rates.
        </EmptyState>
      ) : asTable ? (
        <div className="max-h-96 overflow-auto rounded-md border">
          <Table>
            <TableCaption className="sr-only">{heading}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Period</TableHead>
                <TableHead scope="col" className="text-right">
                  {label}
                </TableHead>
                <TableHead scope="col">Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.rows.map((row) => (
                <TableRow key={row.bucket}>
                  <TableCell>
                    {granularity === "day" ? row.from : `${row.from} – ${row.to}`}
                  </TableCell>
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
          No bucket in the range has a value for {label.toLowerCase()}.
        </EmptyState>
      ) : (
        <figure>
          <ChartContainer
            config={config}
            className="aspect-auto h-72 w-full"
            role="img"
            aria-label={heading}
          >
            <LineChart data={plotRows(series.rows)} margin={{ left: 8, right: 8, top: 8 }}>
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
                content={(props) => (
                  <TooltipBody
                    active={props.active}
                    payload={props.payload as ReadonlyArray<{ payload?: unknown }>}
                    granularity={granularity}
                  />
                )}
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
          <figcaption className="mt-1 text-xs text-muted-foreground">
            Dashed segments and hollow points are partial buckets; gaps are periods without synced
            data.
          </figcaption>
        </figure>
      )}
    </section>
  );
}
