import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PageHeader } from "../page-header";
import { SURFACE } from "../surface";

/** The /social title and description, with the Instagram | YouTube switch on the right. */
export function OrganicPageHeader({
  title,
  description,
  switcher,
}: {
  title: string;
  description: string;
  switcher?: ReactNode;
}) {
  return <PageHeader title={title} description={description} actions={switcher} />;
}

/** The account (or channel) picker and the selected account's summary, on one surface. */
export function IdentityBar({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        SURFACE,
        "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5",
      )}
    >
      {children}
    </div>
  );
}
