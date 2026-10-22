import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { CLERK_PUBLISHABLE_KEY } from "@/lib/auth/config";
import { CHOOSE_ORGANIZATION_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth/mode";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Marketing Microservice", template: "%s · Marketing Microservice" },
  description: "Unified ad spend, campaign, engagement and messaging analytics.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const document = (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
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
      signInUrl={SIGN_IN_PATH}
      signUpUrl={SIGN_UP_PATH}
      afterSignOutUrl={SIGN_IN_PATH}
      taskUrls={{ "choose-organization": CHOOSE_ORGANIZATION_PATH }}
    >
      {document}
    </ClerkProvider>
  );
}
