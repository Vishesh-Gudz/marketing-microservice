import { describe, expect, it } from "vitest";
import { mockInstagramCode } from "@/convex/providers/social/mock";
import { mockInstagramCode as seedMockInstagramCode } from "../../scripts/dev-seed.mjs";

// scripts/dev-seed.mjs (plain Node, dev tooling) cannot import the TypeScript mock, so it
// carries its own copy of the mock Instagram consent code. Keep the two equal.
describe("dev seed", () => {
  it.each(["1", "small", "edge", "creator"])("issues the mock's Instagram code for %s", (user) => {
    expect(seedMockInstagramCode(user)).toBe(mockInstagramCode(user));
  });
});
