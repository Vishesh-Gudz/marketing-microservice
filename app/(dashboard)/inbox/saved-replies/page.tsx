import type { Metadata } from "next";
import { SavedRepliesView } from "@/components/dashboard/views/saved-replies-view";

export const metadata: Metadata = { title: "Saved replies" };

export default function SavedRepliesPage() {
  return <SavedRepliesView />;
}
