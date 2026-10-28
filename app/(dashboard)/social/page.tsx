import type { Metadata } from "next";
import { SocialView } from "@/components/dashboard/views/social-view";

export const metadata: Metadata = { title: "Organic" };

export default function OrganicPage() {
  return <SocialView />;
}
