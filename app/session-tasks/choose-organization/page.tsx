import { TaskChooseOrganization } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthPageShell, ClerkUnavailable } from "@/components/auth/auth-page";
import { CLERK_ENABLED } from "@/lib/auth/config";

export const metadata: Metadata = { title: "Choose an organization" };

// D5: every user works inside an organization. Clerk sends a signed-in user without one here
// (ClerkProvider taskUrls) to create one or accept an invitation.
export default function ChooseOrganizationPage() {
  return (
    <AuthPageShell>
      {CLERK_ENABLED ? <TaskChooseOrganization redirectUrlComplete="/" /> : <ClerkUnavailable />}
    </AuthPageShell>
  );
}
