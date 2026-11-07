import { Compass } from "lucide-react";
import Link from "next/link";
import { SystemMessage } from "@/components/brand/system-message";
import { Brand } from "@/components/dashboard/nav";
import { Button } from "@/components/ui/button";

// Unknown URLs outside the dashboard's routes: the Gudz frame on the dot grid, one way back.
export default function NotFound() {
  return (
    <main
      id="main-content"
      className="gudz-dot-grid flex min-h-dvh flex-1 flex-col items-center justify-center gap-8 bg-canvas p-6"
    >
      <Brand />
      <SystemMessage
        icon={Compass}
        eyebrow="404"
        title="Page not found"
        actions={
          <Button asChild>
            <Link href="/">Go to the overview</Link>
          </Button>
        }
      >
        This page does not exist.
      </SystemMessage>
    </main>
  );
}
