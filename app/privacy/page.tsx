import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { DATA_DELETION_PATH } from "@/lib/auth/mode";
import { LEGAL } from "@/lib/legal/company";

export const metadata: Metadata = { title: "Privacy Policy" };

const list = "flex list-disc flex-col gap-1 pl-5";

/**
 * Public Privacy Policy (no session; Meta and Google require it). Every statement mirrors what
 * the service does (docs/connections.md, docs/whatsapp.md, docs/instagram-messaging.md); change
 * this page together with any change to what is collected or kept.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <LegalSection title="Who we are">
        <p>
          {LEGAL.serviceName} ({LEGAL.serviceUrl}) is a service of {LEGAL.companyName},{" "}
          {LEGAL.registeredAddress} (&quot;we&quot;, &quot;us&quot;). This policy explains what data
          the service collects, how it is used and kept, and how you can have it deleted. Questions:{" "}
          <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.
        </p>
      </LegalSection>

      <LegalSection title="What the service does">
        <p>
          Businesses use {LEGAL.serviceName} to see their advertising and social media results in
          one dashboard, and to read and answer the messages their customers send them on WhatsApp
          and Instagram. A business connects each platform itself, by signing in to that platform
          and granting access; it can disconnect at any time.
        </p>
      </LegalSection>

      <LegalSection title="Data we collect">
        <ul className={list}>
          <li>
            <strong>Your account:</strong> your name, email address and organization, through our
            sign-in provider.
          </li>
          <li>
            <strong>Advertising data</strong> from the Google Ads and Meta ad accounts you connect:
            account names and ids, campaigns, ad groups, ads and their performance metrics.
          </li>
          <li>
            <strong>Social media data</strong> from the YouTube channels and Instagram professional
            accounts you connect: profile information, posts or videos and their metrics.
          </li>
          <li>
            <strong>Messages</strong> on the WhatsApp numbers and Instagram accounts you connect:
            the customer&apos;s phone number or Instagram user id and name as the platform reports
            it, message text, the time and the delivery status of each message, and the replies your
            team sends.
          </li>
          <li>
            <strong>From the WhatsApp Business app</strong>, when you connect a number you keep
            using in that app: the names and numbers of the contacts saved in the app, the messages
            you send from the app, and, if you choose to share it when connecting, your earlier chat
            history as Meta provides it.
          </li>
          <li>
            <strong>Content your team writes for reuse:</strong> saved replies, message templates
            and Instagram ice breakers.
          </li>
          <li>
            <strong>Access tokens</strong> the platforms issue when you connect. They are stored
            encrypted and used only to act on your behalf.
          </li>
          <li>
            <strong>Technical records:</strong> an audit log of actions in your organization (who
            connected, linked or disconnected what, and when) and service logs. Message contents and
            access tokens are never written to logs.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How we use it">
        <p>
          Only to provide the service to your organization: to show your dashboards, keep the data
          up to date, show your inbox and send the replies your team writes. We do not sell your
          data, use it for advertising, or share it with other customers of the service. Each
          organization can see only its own data.
        </p>
      </LegalSection>

      <LegalSection title="Who we share it with">
        <ul className={list}>
          <li>
            <strong>The platforms you connect</strong> (Google, Meta): we call their APIs with your
            authorization to read your data and send your replies.
          </li>
          <li>
            <strong>Our service providers</strong>, which process data only to run the service:
            Convex (database and backend), Vercel (website hosting) and Clerk (sign-in).
          </li>
          <li>
            <strong>Authorities</strong>, when the law requires it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How long we keep it">
        <ul className={list}>
          <li>Data is kept while your organization uses the service.</li>
          <li>
            <strong>When you disconnect a platform</strong>, its access token is deleted at once.
            YouTube channel data is deleted with it. Advertising data, Instagram analytics and
            WhatsApp conversations stay in your organization until you ask us to delete them.
          </li>
          <li>
            <strong>Contacts imported from the WhatsApp Business app</strong> are deleted here when
            you remove them in the app; the rest stays with your WhatsApp conversations.
          </li>
          <li>
            <strong>Instagram direct messages</strong> are deleted 30 days after messaging stops for
            that account (turned off, disconnected or the permission removed).
          </li>
          <li>
            <strong>Incoming webhook notifications</strong> from WhatsApp and Instagram are deleted
            30 days after we receive them.
          </li>
          <li>
            Everything else is deleted when you ask us to (see{" "}
            <Link href={DATA_DELETION_PATH}>Data Deletion</Link>).
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How we protect it">
        <p>
          Access tokens are encrypted at rest (AES-256-GCM). All traffic uses HTTPS. Messages from
          WhatsApp and Instagram are accepted only with a valid platform signature. Every request is
          checked against the signed-in user&apos;s organization and role.
        </p>
      </LegalSection>

      <LegalSection title="Google user data">
        <p>
          {LEGAL.serviceName}&apos;s use and transfer of information received from Google APIs
          adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We use read-only access to YouTube and Google
          Ads data only to show it in your dashboard.
        </p>
      </LegalSection>

      <LegalSection title="Your choices and rights">
        <p>
          You can disconnect any platform at any time on the Connections page, and ask us to access,
          correct or delete your data by writing to{" "}
          <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>. How deletion works is
          described on the <Link href={DATA_DELETION_PATH}>Data Deletion</Link> page.
        </p>
      </LegalSection>

      <LegalSection title="Children">
        <p>The service is for businesses and is not directed at children.</p>
      </LegalSection>

      <LegalSection title="Changes to this policy">
        <p>We publish any change on this page with a new effective date.</p>
      </LegalSection>
    </LegalPage>
  );
}
