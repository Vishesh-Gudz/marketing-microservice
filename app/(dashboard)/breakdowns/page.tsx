import type { Metadata } from "next";
import { BreakdownsView } from "@/components/dashboard/views/breakdowns-view";

export const metadata: Metadata = { title: "Breakdowns" };

export default function BreakdownsPage() {
  return <BreakdownsView />;
}
