import { SignUp } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthPageShell, ClerkUnavailable } from "@/components/auth/auth-page";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage() {
  return (
    <AuthPageShell>
      {CLERK_ENABLED ? (
        <SignUp
          path={SIGN_UP_PATH}
          routing="path"
          signInUrl={SIGN_IN_PATH}
          fallbackRedirectUrl="/"
        />
      ) : (
        <ClerkUnavailable />
      )}
    </AuthPageShell>
  );
}
