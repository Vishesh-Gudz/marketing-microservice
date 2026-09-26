import type { Metadata } from "next";
import { AdGroupDetailView } from "@/components/dashboard/views/campaign-detail-view";

export const metadata: Metadata = { title: "Ad group" };

export default async function AdGroupPage({
  params,
}: PageProps<"/campaigns/[campaignId]/ad-groups/[adGroupId]">) {
  const { campaignId, adGroupId } = await params;
  return <AdGroupDetailView campaignId={campaignId} adGroupId={adGroupId} />;
}
