import { renderHook } from "@testing-library/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/convex/_generated/api";
import { apiError, isMarketingError } from "@/convex/lib/errors";
import {
  ensureMock,
  mockAction,
  mockMutation,
  queryResults,
  resetHarness,
  useActionMock,
  useMutationMock,
} from "./dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);

// The harness itself: per-function mutation and action mocks, as components see them through
// convex/react's hooks, and the unchanged default (unregistered mutations → ensureMock).

const BEGIN = "v1/connections:beginConnect";
const LINK = "v1/connections:linkAdAccounts";
const REFRESH = "v1/connections:refreshAssets";
/** A second action, so two actions can be told apart (no other public action exists yet). */
const otherAction = makeFunctionReference<"action">("v1/testOnly:otherAction");

describe("dashboard harness: actions", () => {
  beforeEach(() => resetHarness());

  it("separate actions return their own results and errors", async () => {
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: "https://example.test/a", expiresAt: "x" });
    mockAction("v1/testOnly:otherAction").mockRejectedValue(apiError("FORBIDDEN", "no"));

    const begin = renderHook(() => useAction(api.v1.connections.beginConnect)).result.current;
    const other = renderHook(() => useAction(otherAction)).result.current;

    await expect(begin({ provider: "google_ads" })).resolves.toEqual({
      authorizeUrl: "https://example.test/a",
      expiresAt: "x",
    });
    const error = await other({}).catch((e: unknown) => e);
    expect(isMarketingError(error) && error.data.code).toBe("FORBIDDEN");
    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({ provider: "google_ads" });
    expect(mockAction("v1/testOnly:otherAction")).toHaveBeenCalledOnce();
  });

  it("returns the same function on every render (stable, like Convex's hook)", () => {
    const { result, rerender } = renderHook(() => useAction(api.v1.connections.beginConnect));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first).toBe(mockAction(BEGIN));
  });

  it("an unconfigured action rejects with a descriptive error", async () => {
    const begin = renderHook(() => useAction(api.v1.connections.beginConnect)).result.current;
    await expect(begin({ provider: "google_ads" })).rejects.toThrow(
      `No result configured for action ${BEGIN}`,
    );
  });
});

describe("dashboard harness: mutations", () => {
  beforeEach(() => resetHarness());

  it("separate mutations return their own results and errors", async () => {
    mockMutation(LINK).mockResolvedValue([{ id: "a1" }]);
    mockMutation(REFRESH).mockRejectedValue(
      apiError("CONFLICT", "inactive", { reason: "connection_inactive" }),
    );

    const link = renderHook(() => useMutation(api.v1.connections.linkAdAccounts)).result.current;
    const refresh = renderHook(() => useMutation(api.v1.connections.refreshAssets)).result.current;

    await expect(link({ connectionId: "c1", externalIds: ["1"] })).resolves.toEqual([{ id: "a1" }]);
    const error = await refresh({ connectionId: "c1" }).catch((e: unknown) => e);
    expect(isMarketingError(error) && error.data.details?.reason).toBe("connection_inactive");
    expect(mockMutation(LINK)).toHaveBeenCalledExactlyOnceWith({
      connectionId: "c1",
      externalIds: ["1"],
    });
    expect(mockMutation(REFRESH)).toHaveBeenCalledOnce();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("an unconfigured registered mutation rejects with a descriptive error", async () => {
    mockMutation(LINK);
    const link = renderHook(() => useMutation(api.v1.connections.linkAdAccounts)).result.current;
    await expect(link({ connectionId: "c1", externalIds: [] })).rejects.toThrow(
      `No result configured for mutation ${LINK}`,
    );
  });
});

describe("dashboard harness: backward compatibility", () => {
  beforeEach(() => resetHarness());

  it("an unregistered mutation is still the shared ensureMock (org gate)", async () => {
    ensureMock.mockResolvedValue({ id: "org" });
    const ensure = renderHook(() => useMutation(api.v1.orgs.ensure)).result.current;
    expect(ensure).toBe(ensureMock);
    await expect(ensure({})).resolves.toEqual({ id: "org" });
  });

  it("registering one mutation leaves the others on ensureMock", () => {
    mockMutation(LINK);
    expect(renderHook(() => useMutation(api.v1.orgs.ensure)).result.current).toBe(ensureMock);
    expect(
      renderHook(() => useMutation(api.v1.connections.linkAdAccounts)).result.current,
    ).not.toBe(ensureMock);
  });

  it("queries are unaffected", () => {
    queryResults.set("v1/connections:list", [{ id: "c1" }]);
    expect(renderHook(() => useQuery(api.v1.connections.list, {})).result.current).toEqual([
      { id: "c1" },
    ]);
  });

  it("resetHarness clears registrations and calls", async () => {
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: "x", expiresAt: "y" });
    mockMutation(LINK).mockResolvedValue([]);
    renderHook(() => [useAction(api.v1.connections.beginConnect), useMutation(api.v1.orgs.ensure)]);
    expect(useActionMock).toHaveBeenCalled();
    expect(useMutationMock).toHaveBeenCalled();

    resetHarness();
    expect(useActionMock).not.toHaveBeenCalled();
    expect(useMutationMock).not.toHaveBeenCalled();
    // A fresh, unconfigured mock replaces the old one; unregistered mutations fall back again.
    await expect(mockAction(BEGIN)({})).rejects.toThrow("No result configured");
    expect(renderHook(() => useMutation(api.v1.connections.linkAdAccounts)).result.current).toBe(
      ensureMock,
    );
  });
});
