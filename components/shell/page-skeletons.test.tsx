import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ConversationSkeleton,
  LibrarySkeleton,
  RecordSkeleton,
  WorkspaceSkeleton,
} from "./page-skeletons";

describe("route loading states", () => {
  it.each([
    ["workspace", WorkspaceSkeleton],
    ["record", RecordSkeleton],
    ["library", LibrarySkeleton],
    ["conversation", ConversationSkeleton],
  ])("%s: a labelled busy status with the top progress bar", (_, Skeleton) => {
    render(<Skeleton />);
    expect(screen.getByRole("status", { name: "Loading page" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("route-progress")).toHaveAttribute("aria-hidden", "true");
  });
});
