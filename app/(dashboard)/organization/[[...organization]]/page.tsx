import { OrganizationProfile } from "@clerk/nextjs";
import type { Metadata } from "next";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ReportingSettings } from "@/components/dashboard/organization/reporting-settings";
import { PageHeader } from "@/components/dashboard/page-header";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { ORGANIZATION_PATH } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Organization" };

/**
 * Clerk's profile as a settings page: the full content width and the Gudz surface instead of a
 * floating card. Layout only; every Clerk element stays where Clerk puts it.
 */
const PROFILE_APPEARANCE = {
  elements: {
    rootBox: "w-full!",
    cardBox: "w-full! max-w-none! rounded-[14px]! border! border-line! shadow-soft!",
  },
};

// The reporting currency and time zone (C1) come first: they are this app's own settings.
// D9: members, invitations and roles are managed with Clerk's embedded organization profile.
// Clerk enforces who may invite or change roles; the backend reads the resulting role from
// every token (org:admin, org:editor, org:viewer).
export default function OrganizationPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Organization"
        description="Your organization's reporting currency and time zone, members, invitations and roles."
      />
      <ReportingSettings />
      {CLERK_ENABLED ? (
        <OrganizationProfile
          path={ORGANIZATION_PATH}
          routing="path"
          appearance={PROFILE_APPEARANCE}
        />
      ) : (
        <EmptyState title="Organization settings">
          Members and invitations are managed with Clerk sign-in. This build uses the local dev
          token, so there is nothing to manage here.
        </EmptyState>
      )}
    </div>
  );
}
