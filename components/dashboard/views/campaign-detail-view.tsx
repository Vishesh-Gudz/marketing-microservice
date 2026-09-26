"use client";

import { api } from "@/convex/_generated/api";
import { filterParamsOnly } from "@/lib/analytics/filters";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { ActionsPanel } from "../actions-panel";
import { Breadcrumbs } from "../page-header";
import { PerformanceTable } from "../performance-table";
import { QueryBoundary } from "../query-boundary";
import { EntityDetail } from "./entity-detail";

function useLinkQuery() {
  const { searchParams } = useDashboardFilters();
  const query = filterParamsOnly(new URLSearchParams(searchParams.toString())).toString();
  return (href: string) => (query ? `${href}?${query}` : href);
}

/** One campaign: summary, KPIs, trend, and tabs for its ad groups, ads and conversions. */
export function CampaignDetailView({ campaignId }: { campaignId: string }) {
  const scope = useAnalyticsScope();
  const withQuery = useLinkQuery();
  const back = withQuery("/campaigns");
  return (
    <QueryBoundary
      resetKey={JSON.stringify([campaignId, scope.range, scope.compare])}
      title="Campaign"
      notFoundAsPage
    >
      <EntityDetail
        level="campaign"
        id={campaignId}
        breadcrumbs={(entity) => (
          <Breadcrumbs
            items={[{ label: "Campaigns", href: back }, { label: entity?.name ?? "Campaign" }]}
          />
        )}
        tabs={() => [
          {
            value: "ad_groups",
            label: "Ad groups",
            content: (
              <PerformanceTable
                level="ad_group"
                parent={{ campaignId }}
                useAccountFilters={false}
                caption="Ad groups"
                hrefFor={(row) => `/campaigns/${campaignId}/ad-groups/${row.entity.id}`}
              />
            ),
          },
          {
            value: "ads",
            label: "Ads",
            content: (
              <PerformanceTable
                level="ad"
                parent={{ campaignId }}
                useAccountFilters={false}
                caption="Ads"
              />
            ),
          },
          {
            value: "conversions",
            label: "Conversions",
            content: (
              <ActionsPanel
                args={{ range: scope.range, entity: { level: "campaign", id: campaignId } }}
              />
            ),
          },
        ]}
      />
    </QueryBoundary>
  );
}

function AdGroupBreadcrumbs({
  campaignId,
  adGroupName,
}: {
  campaignId: string;
  adGroupName: string | undefined;
}) {
  const scope = useAnalyticsScope();
  const withQuery = useLinkQuery();
  // The campaign's name for the breadcrumb (overview with entity, D5).
  const { data } = useAnalyticsQuery(api.v1.analytics.overview, {
    range: scope.range,
    entity: { level: "campaign", id: campaignId },
  });
  return (
    <Breadcrumbs
      items={[
        { label: "Campaigns", href: withQuery("/campaigns") },
        { label: data?.entity?.name ?? "Campaign", href: withQuery(`/campaigns/${campaignId}`) },
        { label: adGroupName ?? "Ad group" },
      ]}
    />
  );
}

/** One ad group: summary, KPIs, trend, ads and conversions. The URL's campaign must be its parent. */
export function AdGroupDetailView({
  campaignId,
  adGroupId,
}: {
  campaignId: string;
  adGroupId: string;
}) {
  const scope = useAnalyticsScope();
  return (
    <QueryBoundary
      resetKey={JSON.stringify([campaignId, adGroupId, scope.range, scope.compare])}
      title="Ad group"
      notFoundAsPage
    >
      <EntityDetail
        level="ad_group"
        id={adGroupId}
        validate={(entity) => entity.campaignId === campaignId}
        breadcrumbs={(entity) => (
          <AdGroupBreadcrumbs campaignId={campaignId} adGroupName={entity?.name} />
        )}
        tabs={() => [
          {
            value: "ads",
            label: "Ads",
            content: (
              <PerformanceTable
                level="ad"
                parent={{ adGroupId }}
                useAccountFilters={false}
                caption="Ads"
              />
            ),
          },
          {
            value: "conversions",
            label: "Conversions",
            content: (
              <ActionsPanel
                args={{ range: scope.range, entity: { level: "ad_group", id: adGroupId } }}
              />
            ),
          },
        ]}
      />
    </QueryBoundary>
  );
}
