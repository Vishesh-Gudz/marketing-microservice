import Link from "next/link";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";

// Entity pages call notFound() when the API answers NOT_FOUND (a foreign, unknown or
// malformed id) or the URL's parent does not match; this renders inside the shell.
export default function DashboardNotFound() {
  return (
    <EmptyState
      title="Not found"
      className="mt-8"
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      }
    >
      This item does not exist or is not available to your organization.
    </EmptyState>
  );
}
