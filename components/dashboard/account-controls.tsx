"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { useAuthUi } from "@/lib/auth/auth-ui";
import { ORGANIZATION_PATH } from "@/lib/auth/mode";

/**
 * Clerk organization switcher and user menu (Clerk mode only). No personal workspace (D5).
 * After a switch the dashboard returns to the overview, so no filter or selection of the
 * previous organization carries over.
 */
export function AccountControls() {
  const { mode } = useAuthUi();
  if (mode !== "clerk") return null;
  return (
    <span className="flex items-center gap-2">
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/"
        afterCreateOrganizationUrl="/"
        organizationProfileMode="navigation"
        organizationProfileUrl={ORGANIZATION_PATH}
      />
      <UserButton />
    </span>
  );
}
