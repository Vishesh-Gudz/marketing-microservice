import { render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { isLoading: false, isAuthenticated: true };
const ensureMock = vi.fn();
const useQueryMock = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => auth,
  useMutation: () => ensureMock,
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

import { OrgStatus } from "./org-status";

const org = {
  id: "o1",
  externalOrgId: "acme",
  issuer: "https://dev-issuer.marketing.local",
  displayName: "Acme",
  reportingCurrency: "USD",
  timezone: "UTC",
  role: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("OrgStatus", () => {
  beforeEach(() => {
    auth.isLoading = false;
    auth.isAuthenticated = true;
    ensureMock.mockReset();
    useQueryMock.mockReset();
  });

  it("explains how to get a token when unauthenticated", () => {
    auth.isAuthenticated = false;
    useQueryMock.mockReturnValue(undefined);
    render(<OrgStatus />);
    expect(screen.getByText(/no token/i)).toBeInTheDocument();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("provisions, then shows the resolved org and role", async () => {
    ensureMock.mockResolvedValue(org);
    useQueryMock.mockImplementation((_fn, args) => (args === "skip" ? undefined : org));
    render(<OrgStatus />);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(ensureMock).toHaveBeenCalledOnce();
  });

  it("shows the standardized error code when provisioning fails", async () => {
    ensureMock.mockRejectedValue(
      new ConvexError({ code: "APP_NOT_REGISTERED", message: "unknown issuer" }),
    );
    useQueryMock.mockReturnValue(undefined);
    render(<OrgStatus />);
    expect(await screen.findByText("APP_NOT_REGISTERED")).toBeInTheDocument();
  });
});
