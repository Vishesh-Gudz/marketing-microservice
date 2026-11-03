/**
 * The details the Privacy Policy and Data Deletion pages show (app/privacy, app/data-deletion).
 * One place to change them. `lib/legal/company.test.ts` fails while any value is still a
 * placeholder, so the pages cannot be released without the real details.
 */
export const LEGAL_PLACEHOLDER = "TO_BE_PROVIDED";

export const LEGAL = {
  /** The legal entity that operates the service. */
  companyName: "Hyperion Future Tech Ventures Private Limited",
  /** The product name shown to users. */
  serviceName: "Marketing Microservice",
  /** Where the service runs. */
  serviceUrl: "https://marketing-microservice.vercel.app",
  /** The company's registered address. */
  registeredAddress:
    "Unit No-1022, Tower-B4, Tech Park, Sector-49, Gurugram (Gurgaon), Haryana, 122018, India",
  /** Where privacy questions and deletion requests go. */
  contactEmail: "software@gudz.in",
  /** When this version of both pages takes effect (YYYY-MM-DD). */
  effectiveDate: "2026-11-03",
} as const;

/** "3 November 2026" for an ISO date (UTC, fixed English wording on legal pages). */
export function formatLegalDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
