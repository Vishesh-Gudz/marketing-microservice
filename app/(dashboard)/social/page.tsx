import type { Metadata } from "next";
import { OrganicView } from "@/components/dashboard/views/organic-view";

export const metadata: Metadata = { title: "Organic" };

export default function OrganicPage() {
  return <OrganicView />;
}
