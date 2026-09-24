import { ConvexStatus } from "@/components/convex-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Phase 0 placeholder. Dashboard routes arrive in Phase 7 under app/(dashboard)/.
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Marketing Microservice</h1>
          </CardTitle>
          <CardDescription>
            Unified ad spend, campaign, engagement and messaging analytics.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>Backend status</span>
          <ConvexStatus />
        </CardContent>
      </Card>
    </main>
  );
}
