"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { useAuthUi } from "@/lib/auth/auth-ui";
import { ORGANIZATION_PATH } from "@/lib/auth/mode";
import { cn } from "@/lib/utils";

// Style objects, not class names: they go through Clerk's own styling, so they always win
// over its defaults (utility classes would depend on stylesheet order).
const SWITCHER_FULL = {
  rootBox: { width: "100%" },
  organizationSwitcherTrigger: {
    width: "100%",
    justifyContent: "space-between",
    padding: "6px 8px",
    borderRadius: "10px",
  },
};
const SWITCHER_RAIL = {
  organizationSwitcherTrigger: { padding: "4px", borderRadius: "10px" },
  organizationPreviewTextContainer: { display: "none" },
  organizationSwitcherTriggerIcon: { display: "none" },
};

/**
 * Clerk organization switcher (Clerk mode only), at the top of the sidebar and the phone
 * menu. No personal workspace (D5). After a switch the dashboard returns to the overview, so
 * no filter or selection of the previous organization carries over.
 */
export function OrganizationControl({ collapsed = false }: { collapsed?: boolean }) {
  const { mode } = useAuthUi();
  if (mode !== "clerk") return null;
  return (
    <div className={cn("shrink-0 pb-2", collapsed ? "flex justify-center" : "px-3")}>
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/"
        afterCreateOrganizationUrl="/"
        organizationProfileMode="navigation"
        organizationProfileUrl={ORGANIZATION_PATH}
        appearance={{ elements: collapsed ? SWITCHER_RAIL : SWITCHER_FULL }}
      />
    </div>
  );
}

/** Clerk user menu (Clerk mode only), at the end of the top bar. */
export function UserControl() {
  const { mode } = useAuthUi();
  if (mode !== "clerk") return null;
  return <UserButton />;
}
