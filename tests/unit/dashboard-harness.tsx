import { render } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactElement } from "react";
import { vi, type Mock } from "vitest";
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
 *
 * Mutations and actions: `mockMutation(name)` / `mockAction(name)` return the per-function
 * mock that `useMutation(ref)` / `useAction(ref)` hand to components (stable per name, like
 * Convex's hooks). Configure it with mockResolvedValue / mockRejectedValue after
 * resetHarness(). A registered mock that is called without being configured rejects with a
 * descriptive error. Unregistered mutations still return the shared `ensureMock` (backward
 * compatible: the org gate's v1/orgs:ensure); unregistered actions reject the same way.
 */

type Result = unknown | ((args: Record<string, unknown>) => unknown);
type CallMock = Mock<(args?: Record<string, unknown>) => Promise<unknown>>;

export const queryResults = new Map<string, Result>();
export const auth = { isLoading: false, isAuthenticated: true };
export const ensureMock = vi.fn();

const mutationMocks = new Map<string, CallMock>();
const actionMocks = new Map<string, CallMock>();

function registered(registry: Map<string, CallMock>, kind: string, name: string): CallMock {
  let mock = registry.get(name);
  if (mock === undefined) {
    mock = vi.fn(async () => {
      throw new Error(`No result configured for ${kind} ${name} (test harness)`);
    });
    registry.set(name, mock);
  }
  return mock;
}

/** The mock `useMutation` returns for this public function name ("v1/connections:linkAdAccounts"). */
export function mockMutation(name: string): CallMock {
  return registered(mutationMocks, "mutation", name);
}

/** The mock `useAction` returns for this public function name ("v1/connections:beginConnect"). */
export function mockAction(name: string): CallMock {
  return registered(actionMocks, "action", name);
}

export const useMutationMock = vi.fn(
  (ref: FunctionReference<"mutation">) => mutationMocks.get(getFunctionName(ref)) ?? ensureMock,
);

export const useActionMock = vi.fn((ref: FunctionReference<"action">) =>
  mockAction(getFunctionName(ref)),
);

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

/** `loadMore` of every paginated query (one shared mock: assert calls on it). */
export const loadMoreMock = vi.fn();

/**
 * Convex `usePaginatedQuery`: the registered result for the function (a value or a function of
 * the arguments, like queries) is ONE page `{ page, isDone }` for the first page's arguments
 * (`paginationOpts: { numItems: initialNumItems, cursor: null }`, recorded like a query's).
 * Unregistered: still loading. Throwing inside it simulates a failed query.
 */
export const usePaginatedQueryMock = vi.fn(
  (
    ref: FunctionReference<"query">,
    args: Record<string, unknown> | "skip",
    options: { initialNumItems: number },
  ) => {
    const loading = {
      results: [],
      status: "LoadingFirstPage",
      isLoading: true,
      loadMore: loadMoreMock,
    };
    if (args === "skip") return loading;
    const page = useQueryMock(ref, {
      ...args,
      paginationOpts: { numItems: options.initialNumItems, cursor: null },
    }) as { page: unknown[]; isDone: boolean } | undefined;
    if (page === undefined) return loading;
    return {
      results: page.page,
      status: page.isDone ? "Exhausted" : "CanLoadMore",
      isLoading: false,
      loadMore: loadMoreMock,
    };
  },
);

export const convexReact = {
  useQuery: useQueryMock,
  usePaginatedQuery: usePaginatedQueryMock,
  useConvexAuth: () => auth,
  useMutation: useMutationMock,
  useAction: useActionMock,
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

/** Arguments of every call to a query ("skip" when skipped), by public function name. */
export function allArgs(name: string): (Record<string, unknown> | "skip" | undefined)[] {
  return useQueryMock.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args);
}

export function resetHarness() {
  queryResults.clear();
  stableResults.clear();
  useQueryMock.mockClear();
  usePaginatedQueryMock.mockClear();
  loadMoreMock.mockReset();
  ensureMock.mockReset();
  mutationMocks.clear();
  actionMocks.clear();
  useMutationMock.mockClear();
  useActionMock.mockClear();
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
