import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/dashboard/nav";
import { DATA_DELETION_PATH, PRIVACY_PATH } from "@/lib/auth/mode";
import { formatLegalDate, LEGAL } from "@/lib/legal/company";

/**
 * Layout of the public Privacy Policy and Data Deletion pages: outside the dashboard shell,
 * no session and no backend calls (Meta's and Google's crawlers must be able to read them).
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <Brand />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {LEGAL.serviceName}, operated by {LEGAL.companyName}. Effective{" "}
          {formatLegalDate(LEGAL.effectiveDate)}.
        </p>
      </header>
      <div className="flex flex-col gap-6 text-sm leading-6">{children}</div>
      <footer className="flex flex-wrap gap-4 border-t pt-4 text-sm text-muted-foreground">
        <Link href={PRIVACY_PATH} className="underline underline-offset-4">
          Privacy Policy
        </Link>
        <Link href={DATA_DELETION_PATH} className="underline underline-offset-4">
          Data Deletion
        </Link>
        <span>
          Contact:{" "}
          <a href={`mailto:${LEGAL.contactEmail}`} className="underline underline-offset-4">
            {LEGAL.contactEmail}
          </a>
        </span>
      </footer>
    </main>
  );
}

/** One numbered section of a legal page. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}
