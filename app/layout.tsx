import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { CLERK_APPEARANCE } from "@/components/brand/clerk-appearance";
import { CLERK_PUBLISHABLE_KEY } from "@/lib/auth/config";
import { CHOOSE_ORGANIZATION_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth/mode";
import { Providers } from "./providers";
import "./globals.css";

// The Gudz type: Instrument Sans for everything, JetBrains Mono for ids and codes
// (as on gudz-landing @ redesign-2026, app/[locale]/layout.tsx).
const instrument = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Gudz Marketing", template: "%s · Gudz Marketing" },
  description: "Unified ad spend, campaign, engagement and messaging analytics.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const document = (
    <html lang="en" className={`${instrument.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
  // Clerk is mounted only when it is the configured identity (lib/auth/config.ts); dev-token
  // builds and builds without a Clerk key never load it.
  if (CLERK_PUBLISHABLE_KEY === undefined) return document;
  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={CLERK_APPEARANCE}
      signInUrl={SIGN_IN_PATH}
      signUpUrl={SIGN_UP_PATH}
      afterSignOutUrl={SIGN_IN_PATH}
      taskUrls={{ "choose-organization": CHOOSE_ORGANIZATION_PATH }}
    >
      {document}
    </ClerkProvider>
  );
}
