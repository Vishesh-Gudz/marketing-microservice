import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { CLERK_ENABLED } from "@/lib/auth/config";
import { CHOOSE_ORGANIZATION_PATH, isPublicAuthPath, isSessionTaskPath } from "@/lib/auth/mode";

// Next.js 16 "proxy" (formerly middleware). With Clerk configured it keeps the session in sync
// and sends visitors to sign-in (no session) or to "choose an organization" (signed in, no
// organization yet, D5). This is a navigation convenience, not the security boundary: every
// Convex call verifies the token and the organization itself. Dev-token builds and builds
// without Clerk keys pass every request through untouched.

const clerk =
  CLERK_ENABLED && process.env.CLERK_SECRET_KEY
    ? clerkMiddleware(async (auth, request) => {
        const path = request.nextUrl.pathname;
        if (isPublicAuthPath(path)) return;
        const { userId, sessionStatus, redirectToSignIn } = await auth({
          treatPendingAsSignedOut: false,
        });
        if (!userId) return redirectToSignIn({ returnBackUrl: request.url });
        if (sessionStatus === "pending" && !isSessionTaskPath(path)) {
          return NextResponse.redirect(new URL(CHOOSE_ORGANIZATION_PATH, request.url));
        }
      })
    : null;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  return clerk ? clerk(request, event) : NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
    // Always run for Clerk-specific frontend API routes
    "/__clerk/(.*)",
  ],
};
