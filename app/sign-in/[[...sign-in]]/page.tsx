import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthPageShell, ClerkCardPlaceholder, ClerkUnavailable } from "@/components/auth/auth-page";
import { CLERK_EMBEDDED } from "@/components/brand/clerk-appearance";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthPageShell
      title="Sign in to Gudz Marketing"
      description="Welcome back. Sign in to open your organization's dashboard."
    >
      {CLERK_ENABLED ? (
        <>
          <ClerkCardPlaceholder />
          <SignIn
            path={SIGN_IN_PATH}
            routing="path"
            signUpUrl={SIGN_UP_PATH}
            fallbackRedirectUrl="/"
            appearance={CLERK_EMBEDDED}
          />
        </>
      ) : (
        <ClerkUnavailable />
      )}
    </AuthPageShell>
  );
}
