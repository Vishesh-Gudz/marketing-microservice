import type { Metadata } from "next";
import { YouTubeVideoDetailView } from "@/components/dashboard/views/youtube-video-detail-view";

export const metadata: Metadata = { title: "YouTube video" };

// Ownership is checked by the API (v1/youtubeAnalytics:video); the id is passed through
// untouched and an unknown or foreign id renders "Not found".
export default async function YouTubeVideoPage({
  params,
}: PageProps<"/social/youtube/videos/[videoId]">) {
  const { videoId } = await params;
  return <YouTubeVideoDetailView videoId={videoId} />;
}
