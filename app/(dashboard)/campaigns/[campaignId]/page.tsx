import type { Metadata } from "next";
import { CampaignDetailView } from "@/components/dashboard/views/campaign-detail-view";

export const metadata: Metadata = { title: "Campaign" };

// Ownership is checked by the API (v1/analytics:overview with `entity`); the id is
// passed through untouched and an unknown or foreign id renders "Not found".
export default async function CampaignPage({ params }: PageProps<"/campaigns/[campaignId]">) {
  const { campaignId } = await params;
  return <CampaignDetailView campaignId={campaignId} />;
}
