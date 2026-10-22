import { renderHook } from "@testing-library/react";
import { useAuth } from "@clerk/nextjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClerkConvexAuth } from "./use-clerk-convex-auth";

vi.mock("@clerk/nextjs", () => ({ useAuth: vi.fn() }));

const getToken = vi.fn(async (_options?: unknown) => "clerk.jwt.token");

type ClerkState = {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  orgId: string | null | undefined;
  orgRole: string | null | undefined;
  sessionId: string | null | undefined;
};

let state: ClerkState;

function setClerk(partial: Partial<ClerkState>) {
  state = { ...state, ...partial };
}

beforeEach(() => {
  getToken.mockClear();
  getToken.mockImplementation(async () => "clerk.jwt.token");
  state = {
    isLoaded: true,
    isSignedIn: true,
    orgId: "org_2acme",
    orgRole: "org:admin",
    sessionId: "sess_1",
  };
  vi.mocked(useAuth).mockImplementation(() => ({ ...state, getToken }) as never);
});

describe("useClerkConvexAuth", () => {
  it("requests the 'convex' JWT template for the active organization", async () => {
    const { result } = renderHook(() => useClerkConvexAuth());
    expect(result.current).toMatchObject({ isLoading: false, isAuthenticated: true });
    await expect(result.current.fetchAccessToken({ forceRefreshToken: false })).resolves.toBe(
      "clerk.jwt.token",
    );
    expect(getToken).toHaveBeenLastCalledWith({ template: "convex", skipCache: false });
    await result.current.fetchAccessToken({ forceRefreshToken: true });
    expect(getToken).toHaveBeenLastCalledWith({ template: "convex", skipCache: true });
  });

  it("a signed-in user without an active organization is not authenticated and sends no token", async () => {
    setClerk({ orgId: null, orgRole: null });
    const { result } = renderHook(() => useClerkConvexAuth());
    expect(result.current.isAuthenticated).toBe(false);
    await expect(result.current.fetchAccessToken({ forceRefreshToken: false })).resolves.toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("signed out: not authenticated, no token", async () => {
    setClerk({ isSignedIn: false, orgId: null, orgRole: null, sessionId: null });
    const { result } = renderHook(() => useClerkConvexAuth());
    expect(result.current.isAuthenticated).toBe(false);
    await expect(result.current.fetchAccessToken({ forceRefreshToken: true })).resolves.toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("is loading until Clerk is loaded", () => {
    setClerk({ isLoaded: false, isSignedIn: undefined, orgId: undefined, sessionId: undefined });
    const { result } = renderHook(() => useClerkConvexAuth());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("a Clerk token error yields no token (never a stale one)", async () => {
    getToken.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useClerkConvexAuth());
    await expect(result.current.fetchAccessToken({ forceRefreshToken: false })).resolves.toBeNull();
  });

  it("a new organization, role or session makes Convex fetch a new token; re-renders do not", () => {
    const { result, rerender } = renderHook(() => useClerkConvexAuth());
    const first = result.current.fetchAccessToken;
    rerender();
    expect(result.current.fetchAccessToken).toBe(first);

    setClerk({ orgId: "org_2globex" });
    rerender();
    const afterSwitch = result.current.fetchAccessToken;
    expect(afterSwitch).not.toBe(first);

    setClerk({ orgRole: "org:viewer" });
    rerender();
    expect(result.current.fetchAccessToken).not.toBe(afterSwitch);

    const beforeSession = result.current.fetchAccessToken;
    setClerk({ sessionId: "sess_2" });
    rerender();
    expect(result.current.fetchAccessToken).not.toBe(beforeSession);
  });
});
