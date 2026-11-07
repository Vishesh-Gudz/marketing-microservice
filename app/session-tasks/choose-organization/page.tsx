import { TaskChooseOrganization } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthPageShell, ClerkCardPlaceholder, ClerkUnavailable } from "@/components/auth/auth-page";
import { CLERK_EMBEDDED } from "@/components/brand/clerk-appearance";
import { CLERK_ENABLED } from "@/lib/auth/config";

export const metadata: Metadata = { title: "Choose an organization" };

// D5: every user works inside an organization. Clerk sends a signed-in user without one here
// (ClerkProvider taskUrls) to create one or accept an invitation.
export default function ChooseOrganizationPage() {
  return (
    <AuthPageShell
      title="Choose an organization"
      description="Open one you belong to, accept an invitation, or create a new one."
    >
      {CLERK_ENABLED ? (
        <>
          <ClerkCardPlaceholder />
          <TaskChooseOrganization redirectUrlComplete="/" appearance={CLERK_EMBEDDED} />
        </>
      ) : (
        <ClerkUnavailable />
      )}
    </AuthPageShell>
  );
}
