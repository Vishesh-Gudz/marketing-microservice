import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/brand/brand";
import { DATA_DELETION_PATH, PRIVACY_PATH } from "@/lib/auth/mode";
import { formatLegalDate, LEGAL } from "@/lib/legal/company";

const LINK = "text-blue-deep underline underline-offset-4 hover:text-ink";

/**
 * Layout of the public Privacy Policy and Data Deletion pages: outside the dashboard shell,
 * no session and no backend calls (Meta's and Google's crawlers must be able to read them).
 * The brand frame is a header on the dot grid; the text sits in one readable column.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <main id="main-content" className="flex w-full flex-1 flex-col">
        <header className="gudz-dot-grid border-b border-line bg-canvas">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6 pb-10 sm:px-6">
            <Brand />
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-medium text-blue-deep">Legal</p>
              <h1 className="text-3xl font-semibold tracking-tight text-ink">{title}</h1>
              <p className="text-sm text-muted-foreground">
                {LEGAL.serviceName}, operated by {LEGAL.companyName}. Effective{" "}
                {formatLegalDate(LEGAL.effectiveDate)}.
              </p>
            </div>
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 text-[15px] leading-7 text-ink-2 sm:px-6 [&_a]:text-blue-deep [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-medium [&_strong]:text-ink">
          {children}
        </div>
      </main>
      {/* The page's footer (contentinfo), after the main content. */}
      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <Link href={PRIVACY_PATH} className={LINK}>
            Privacy Policy
          </Link>
          <Link href={DATA_DELETION_PATH} className={LINK}>
            Data Deletion
          </Link>
          <span>
            Contact:{" "}
            <a href={`mailto:${LEGAL.contactEmail}`} className={LINK}>
              {LEGAL.contactEmail}
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}

/** One numbered section of a legal page. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <section aria-labelledby={id} className="flex scroll-mt-6 flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold tracking-tight text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}
