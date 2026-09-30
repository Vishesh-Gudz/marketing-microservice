import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// Dashboard types are derived from the PUBLIC v1 API only (the generated `api`
// references), never from internal modules. Type-only imports (D23).

type Analytics = typeof api.v1.analytics;

export type OverviewArgs = FunctionArgs<Analytics["overview"]>;
export type OverviewResult = FunctionReturnType<Analytics["overview"]>;
export type TimeSeriesArgs = FunctionArgs<Analytics["timeSeries"]>;
export type TimeSeriesResult = FunctionReturnType<Analytics["timeSeries"]>;
export type PerformanceArgs = FunctionArgs<Analytics["performance"]>;
export type PerformancePage = FunctionReturnType<Analytics["performance"]>;
export type BreakdownArgs = FunctionArgs<Analytics["breakdown"]>;
export type BreakdownResult = FunctionReturnType<Analytics["breakdown"]>;
export type ActionsArgs = FunctionArgs<Analytics["actions"]>;
export type ActionsResult = FunctionReturnType<Analytics["actions"]>;
export type Org = FunctionReturnType<typeof api.v1.orgs.me>;
export type AdAccount = FunctionReturnType<typeof api.v1.adAccounts.list>[number];
export type Connection = FunctionReturnType<typeof api.v1.connections.list>[number];

export type Aggregate = OverviewResult["totals"];
export type Metrics = Aggregate["metrics"];
export type Kpis = Aggregate["kpis"];
export type DataState = Aggregate["dataState"];
export type MoneyAmounts = NonNullable<Metrics["spend"]>;
export type Money = MoneyAmounts["native"][number];
export type Comparison = NonNullable<OverviewResult["comparison"]>;
export type Deltas = Comparison["deltas"];
export type Coverage = OverviewResult["coverage"];
export type Fx = OverviewResult["fx"];
export type EntitySummary = NonNullable<OverviewResult["entity"]>;
export type PerformanceRow = PerformancePage["page"][number];
export type PerformanceLevel = PerformanceArgs["level"];
export type TimeSeriesPoint = TimeSeriesResult["points"][number];
export type BreakdownGroup = BreakdownResult["groups"][number];
export type ActionGroup = ActionsResult["groups"][number];
export type AdPlatform = AdAccount["platform"];
export type EntityLevel = TimeSeriesResult["level"];
export type Placement = NonNullable<BreakdownGroup["placement"]>;

export type MetricName = Metrics["unavailableMetrics"][number]["metric"];
export type MetricReason = Metrics["unavailableMetrics"][number]["reason"];
export type KpiName = Kpis["unavailableKpis"][number]["kpi"];
export type KpiReason = Kpis["unavailableKpis"][number]["reason"];
export type DeltaReason = NonNullable<NonNullable<Deltas["clicks"]>["reason"]>;
export type NumberDelta = NonNullable<Deltas["clicks"]>;
export type MoneyDelta = NonNullable<Deltas["spend"]>;
export type ActionKpiName = ActionGroup["unavailableKpis"][number]["kpi"];
