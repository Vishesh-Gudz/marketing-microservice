import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthPageShell, ClerkUnavailable } from "@/components/auth/auth-page";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthPageShell>
      {CLERK_ENABLED ? (
        <SignIn
          path={SIGN_IN_PATH}
          routing="path"
          signUpUrl={SIGN_UP_PATH}
          fallbackRedirectUrl="/"
        />
      ) : (
        <ClerkUnavailable />
      )}
    </AuthPageShell>
  );
}
