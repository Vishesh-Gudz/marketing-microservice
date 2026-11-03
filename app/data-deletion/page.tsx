import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { PRIVACY_PATH } from "@/lib/auth/mode";
import { LEGAL } from "@/lib/legal/company";

export const metadata: Metadata = { title: "Data Deletion" };

const list = "flex list-decimal flex-col gap-1 pl-5";

/**
 * Public data deletion instructions (no session): the URL given to Meta as "Data deletion
 * instructions URL" for each app. Mirrors what disconnecting does (docs/connections.md,
 * docs/whatsapp.md, docs/instagram-messaging.md); full deletion is an operator task on request.
 */
export default function DataDeletionPage() {
  return (
    <LegalPage title="Data Deletion">
      <LegalSection title="Disconnect a platform">
        <p>An organization admin can do this at any time:</p>
        <ol className={list}>
          <li>
            Sign in to {LEGAL.serviceName} and open the Connections page (or WhatsApp settings).
          </li>
          <li>Choose Disconnect on the platform and confirm.</li>
        </ol>
        <p>What happens right away:</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>The platform&apos;s access token is deleted and the data stops updating.</li>
          <li>YouTube: the channel&apos;s stored data is deleted.</li>
          <li>
            Instagram direct messages stop, and the stored conversations and messages are deleted 30
            days later.
          </li>
          <li>
            Advertising data, Instagram analytics and WhatsApp conversations are kept until you ask
            for full deletion (below).
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Remove the app on the platform">
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            Facebook, Instagram and WhatsApp: in Meta Business Settings, open Integrations, then
            Connected apps, and remove {LEGAL.serviceName}. For a personal Facebook sign-in, use
            Settings &amp; privacy, then Apps and websites.
          </li>
          <li>
            Google (YouTube, Google Ads): in your Google Account, open Security, then Third-party
            apps with account access, and remove {LEGAL.serviceName}.
          </li>
        </ul>
        <p>Removing the app stops all access; ask us (below) to delete the data already stored.</p>
      </LegalSection>

      <LegalSection title="Request full deletion">
        <p>
          Email <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> from your
          account&apos;s email address with your organization&apos;s name and, if you want only part
          of the data deleted, which platform or account. We delete the data, including messages and
          analytics, within 30 days and confirm by email. You can also ask what data we hold about
          you.
        </p>
      </LegalSection>

      <p className="text-muted-foreground">
        More about what we collect and keep: <Link href={PRIVACY_PATH}>Privacy Policy</Link>.
      </p>
    </LegalPage>
  );
}
