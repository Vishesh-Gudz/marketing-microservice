import { SearchX } from "lucide-react";
import Link from "next/link";
import { SystemMessage } from "@/components/brand/system-message";
import { Button } from "@/components/ui/button";

// Entity pages call notFound() when the API answers NOT_FOUND (a foreign, unknown or
// malformed id) or the URL's parent does not match; this renders inside the shell.
export default function DashboardNotFound() {
  return (
    <div className="flex justify-center py-10 md:py-16">
      <SystemMessage
        icon={SearchX}
        title="Not found"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/campaigns">Back to campaigns</Link>
          </Button>
        }
      >
        This item does not exist or is not available to your organization.
      </SystemMessage>
    </div>
  );
}
