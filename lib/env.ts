/**
 * Client-visible environment. Only `NEXT_PUBLIC_*` variables belong here;
 * server secrets (platform app secrets, encryption keys) live in Convex
 * environment variables and never reach Next.js. See docs/setup.md.
 *
 * `process.env.NEXT_PUBLIC_*` must be referenced literally so Next.js can
 * inline the values at build time.
 */
export function readConvexUrl(
  value: string | undefined = process.env.NEXT_PUBLIC_CONVEX_URL,
): string {
  if (!value) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is not set. Run `npm run dev:backend` (or `npx convex dev`) " +
        "to create .env.local, or copy .env.example.",
    );
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`NEXT_PUBLIC_CONVEX_URL is not a valid URL: "${value}"`);
  }
  return value;
}
