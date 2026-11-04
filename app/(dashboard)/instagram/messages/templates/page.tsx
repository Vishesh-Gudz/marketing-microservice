import type { Metadata } from "next";
import { InstagramTemplatesView } from "@/components/dashboard/views/instagram-templates-view";

export const metadata: Metadata = { title: "Instagram templates" };

export default function InstagramTemplatesPage() {
  return <InstagramTemplatesView />;
}
