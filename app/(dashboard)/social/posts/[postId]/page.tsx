import type { Metadata } from "next";
import { SocialPostDetailView } from "@/components/dashboard/views/social-post-detail-view";

export const metadata: Metadata = { title: "Post" };

// Ownership is checked by the API (v1/socialPosts:get); the id is passed through untouched
// and an unknown or foreign id renders "Not found".
export default async function SocialPostPage({ params }: PageProps<"/social/posts/[postId]">) {
  const { postId } = await params;
  return <SocialPostDetailView postId={postId} />;
}
