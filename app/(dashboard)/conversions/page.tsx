import type { Metadata } from "next";
import { ConversionsView } from "@/components/dashboard/views/conversions-view";

export const metadata: Metadata = { title: "Conversions" };

export default function ConversionsPage() {
  return <ConversionsView />;
}
