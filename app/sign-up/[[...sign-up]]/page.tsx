import { SignUp } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthPageShell, ClerkCardPlaceholder, ClerkUnavailable } from "@/components/auth/auth-page";
import { CLERK_EMBEDDED } from "@/components/brand/clerk-appearance";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage() {
  return (
    <AuthPageShell
      title="Create your account"
      description="Sign up, then create your organization or join the one that invited you."
    >
      {CLERK_ENABLED ? (
        <>
          <ClerkCardPlaceholder />
          <SignUp
            path={SIGN_UP_PATH}
            routing="path"
            signInUrl={SIGN_IN_PATH}
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
