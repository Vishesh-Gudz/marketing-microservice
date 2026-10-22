import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthUiProvider, type AuthUi } from "@/lib/auth/auth-ui";
import { ORG } from "@/tests/unit/analytics-fixtures";
import { auth, ensureMock, queryResults, resetHarness } from "@/tests/unit/dashboard-harness";
import {
  OrgGateMessage,
  ORG_SWITCH_MAX_ATTEMPTS,
  ORG_SWITCH_RETRY_MS,
  useOrgGate,
} from "./org-gate";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);

const ACME = { ...ORG, id: "org-acme", externalOrgId: "org_2acme", displayName: "Acme" };
const GLOBEX = { ...ORG, id: "org-globex", externalOrgId: "org_2globex", displayName: "Globex" };

let authUi: AuthUi;

function Wrapper({ children }: { children: ReactNode }) {
  return <AuthUiProvider value={authUi}>{children}</AuthUiProvider>;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetHarness();
  vi.useFakeTimers();
  authUi = { mode: "clerk", activeOrgId: "org_2acme", needsOrganization: false };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOrgGate with Clerk organizations", () => {
  it("provisions and shows the active organization", async () => {
    ensureMock.mockResolvedValue(ACME);
    queryResults.set("v1/orgs:me", ACME);
    const { result } = renderHook(() => useOrgGate(), { wrapper: Wrapper });
    await flush();
    expect(result.current).toEqual({ status: "ready", org: ACME });
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  it("switching organizations provisions the new one, waiting out a stale token", async () => {
    ensureMock.mockResolvedValue(ACME);
    queryResults.set("v1/orgs:me", ACME);
    const { result, rerender } = renderHook(() => useOrgGate(), { wrapper: Wrapper });
    await flush();
    expect(result.current.status).toBe("ready");

    // Clerk switched; the Convex client still sends the previous organization's token.
    authUi = { ...authUi, activeOrgId: "org_2globex" };
    rerender();
    await flush();
    expect(ensureMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("resolving");

    // The new token arrives: the retry provisions and shows Globex.
    ensureMock.mockResolvedValue(GLOBEX);
    queryResults.set("v1/orgs:me", GLOBEX);
    await act(async () => {
      vi.advanceTimersByTime(ORG_SWITCH_RETRY_MS);
    });
    await flush();
    expect(ensureMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ status: "ready", org: GLOBEX });
  });

  it("never shows another organization's data, even if v1/orgs:me still returns it", async () => {
    authUi = { ...authUi, activeOrgId: "org_2globex" };
    ensureMock.mockResolvedValue(GLOBEX);
    queryResults.set("v1/orgs:me", ACME);
    const { result } = renderHook(() => useOrgGate(), { wrapper: Wrapper });
    await flush();
    expect(result.current.status).toBe("resolving");
  });

  it("gives up with an error when the switch never completes", async () => {
    authUi = { ...authUi, activeOrgId: "org_2globex" };
    ensureMock.mockResolvedValue(ACME);
    const { result } = renderHook(() => useOrgGate(), { wrapper: Wrapper });
    for (let i = 0; i < ORG_SWITCH_MAX_ATTEMPTS + 1; i++) {
      await flush();
      await act(async () => {
        vi.advanceTimersByTime(ORG_SWITCH_RETRY_MS);
      });
    }
    await flush();
    expect(result.current.status).toBe("error");
    expect(ensureMock).toHaveBeenCalledTimes(ORG_SWITCH_MAX_ATTEMPTS);
  });

  it("is signed out without a Convex-authenticated session (e.g. no active organization)", async () => {
    auth.isAuthenticated = false;
    const { result } = renderHook(() => useOrgGate(), { wrapper: Wrapper });
    await flush();
    expect(result.current).toEqual({ status: "signed_out" });
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("dev mode does not compare organizations", async () => {
    authUi = { mode: "dev", activeOrgId: null, needsOrganization: false };
    ensureMock.mockResolvedValue(ORG);
    queryResults.set("v1/orgs:me", ORG);
    const { result } = renderHook(() => useOrgGate(), { wrapper: Wrapper });
    await flush();
    expect(result.current).toEqual({ status: "ready", org: ORG });
  });
});

describe("OrgGateMessage when signed out", () => {
  function renderMessage() {
    render(
      <Wrapper>
        <OrgGateMessage state={{ status: "signed_out" }} />
      </Wrapper>,
    );
  }

  it("asks a signed-in Clerk user without an organization to choose one", () => {
    authUi = { mode: "clerk", activeOrgId: null, needsOrganization: true };
    renderMessage();
    expect(screen.getByText("Choose an organization", { selector: "a" })).toHaveAttribute(
      "href",
      "/session-tasks/choose-organization",
    );
  });

  it("links a signed-out Clerk visitor to sign-in", () => {
    authUi = { mode: "clerk", activeOrgId: null, needsOrganization: false };
    renderMessage();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    expect(screen.getByText("Sign in")).toHaveAttribute("href", "/sign-in");
  });

  it("explains the dev token in dev mode", () => {
    authUi = { mode: "dev", activeOrgId: null, needsOrganization: false };
    renderMessage();
    expect(screen.getByText("npm run dev:auth setup")).toBeInTheDocument();
  });

  it("states that sign-in is not configured", () => {
    authUi = { mode: "unconfigured", activeOrgId: null, needsOrganization: false };
    renderMessage();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    expect(screen.getByText(/not configured/)).toBeInTheDocument();
  });
});
