import { OrganizationProfile } from "@clerk/nextjs";
import type { Metadata } from "next";
import { EmptyState } from "@/components/dashboard/empty-state";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { ORGANIZATION_PATH } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Organization" };

// D9: members, invitations and roles are managed with Clerk's embedded organization profile.
// Clerk enforces who may invite or change roles; the backend reads the resulting role from
// every token (org:admin, org:editor, org:viewer).
export default function OrganizationPage() {
  return CLERK_ENABLED ? (
    <OrganizationProfile path={ORGANIZATION_PATH} routing="path" />
  ) : (
    <EmptyState title="Organization settings">
      Members and invitations are managed with Clerk sign-in. This build uses the local dev token,
      so there is nothing to manage here.
    </EmptyState>
  );
}
