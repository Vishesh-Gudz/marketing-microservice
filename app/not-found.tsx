import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This page does not exist.</p>
      <Link href="/" className="text-sm underline underline-offset-4">
        Go to the overview
      </Link>
    </main>
  );
}
