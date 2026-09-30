import { render } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OrgProvider } from "@/lib/analytics/org-context";
import type { Org } from "@/lib/analytics/types";
import { ORG } from "./analytics-fixtures";

/**
 * Test harness for dashboard components. Test files wire it up with:
 *   vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
 *   vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);
 * Query results are registered per public function name ("v1/analytics:overview");
 * a function result receives the query arguments. Throwing inside it simulates a
 * failed query (Convex useQuery throws during render).
 */

type Result = unknown | ((args: Record<string, unknown>) => unknown);

export const queryResults = new Map<string, Result>();
export const auth = { isLoading: false, isAuthenticated: true };
export const ensureMock = vi.fn();

// Like Convex's client cache, the same query + arguments yields the same object
// (referentially stable) until the registered result changes.
const stableResults = new Map<string, { source: Result; value: unknown }>();

export const useQueryMock = vi.fn(
  (ref: FunctionReference<"query">, args?: Record<string, unknown> | "skip") => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    const source = queryResults.get(name);
    if (typeof source !== "function") return source;
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    const cached = stableResults.get(key);
    if (cached && cached.source === source) return cached.value;
    const value = source(args ?? {});
    stableResults.set(key, { source, value });
    return value;
  },
);

export const convexReact = {
  useQuery: useQueryMock,
  useConvexAuth: () => auth,
  useMutation: () => ensureMock,
};

export const url = {
  pathname: "/",
  search: new URLSearchParams(),
};
export const routerReplace = vi.fn();

/** next/navigation's notFound() (throws, like the real one). */
export const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND (test)");
});

export const navigation = {
  notFound: notFoundMock,
  usePathname: () => url.pathname,
  useSearchParams: () => url.search,
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
};

export function setUrl(pathname: string, query = "") {
  url.pathname = pathname;
  url.search = new URLSearchParams(query);
}

/** The query string of the last router.replace call. */
export function lastReplacedQuery(): URLSearchParams {
  const href = routerReplace.mock.calls.at(-1)?.[0] as string | undefined;
  return new URLSearchParams(href?.split("?")[1] ?? "");
}

/** Arguments of the last call to a query, by public function name. */
export function lastArgs(name: string): Record<string, unknown> | undefined {
  const calls = useQueryMock.mock.calls.filter(([ref]) => getFunctionName(ref) === name);
  return calls.at(-1)?.[1] as Record<string, unknown> | undefined;
}

export function resetHarness() {
  queryResults.clear();
  stableResults.clear();
  useQueryMock.mockClear();
  ensureMock.mockReset();
  routerReplace.mockReset();
  notFoundMock.mockClear();
  auth.isLoading = false;
  auth.isAuthenticated = true;
  setUrl("/");
}

/** Renders inside the org context (as below OrgGate); `rerender` keeps the providers. */
export function renderWithOrg(ui: ReactElement, org: Org = ORG) {
  return render(ui, {
    wrapper: ({ children }) => (
      <TooltipProvider>
        <OrgProvider org={org}>{children}</OrgProvider>
      </TooltipProvider>
    ),
  });
}
