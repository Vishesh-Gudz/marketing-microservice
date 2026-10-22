import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeltaChip } from "./delta-chip";
import { PartialMarker } from "./partial-marker";
import { ValueText } from "./value-text";

// The partial-data marker: a visible asterisk hidden from assistive technology, and
// "(partial data)" as screen-reader-only text. Never an aria-label on a role-less span
// (axe "aria-prohibited-attr").

function expectAccessibleMarker(container: HTMLElement) {
  const star = screen.getByText("*");
  expect(star).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByText("(partial data)")).toHaveClass("sr-only");
  expect(container.querySelector("span[aria-label]:not([role])")).toBeNull();
}

describe("PartialMarker", () => {
  it("shows an asterisk and tells screen readers the data is partial", () => {
    const { container } = render(<PartialMarker className="text-amber-600" />);
    expectAccessibleMarker(container);
    expect(container.firstElementChild).toHaveClass("text-amber-600");
    expect(container.textContent).toBe("* (partial data)");
  });
});

describe("ValueText", () => {
  it("marks a partial value", () => {
    const { container } = render(
      <ValueText view={{ kind: "value", text: "1,234", partial: true }} />,
    );
    expect(container).toHaveTextContent("1,234* (partial data)");
    expectAccessibleMarker(container);
  });

  it("has no marker for a complete value", () => {
    const { container } = render(
      <ValueText view={{ kind: "value", text: "1,234", partial: false }} />,
    );
    expect(container.textContent).toBe("1,234");
  });

  it("keeps the explicit button name of a partial multi-currency value", () => {
    const { container } = render(
      <ValueText
        view={{
          kind: "value",
          text: "Multiple currencies",
          detail: ["€1.00", "$2.00"],
          partial: true,
        }}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Multiple currencies (partial data): show amounts per currency",
      }),
    ).toBeInTheDocument();
    expectAccessibleMarker(container);
  });
});

describe("DeltaChip", () => {
  it("marks a partial change", () => {
    const { container } = render(
      <DeltaChip metric="clicks" delta={{ percent: 0.25, partial: true }} />,
    );
    expectAccessibleMarker(container);
  });

  it("marks a partial comparison reason", () => {
    const { container } = render(
      <DeltaChip metric="clicks" delta={{ reason: "previous_unavailable", partial: true }} />,
    );
    expect(container).toHaveTextContent("No comparison data* (partial data)");
    expectAccessibleMarker(container);
  });

  it("has no marker for a complete change", () => {
    render(<DeltaChip metric="clicks" delta={{ percent: 0.25 }} />);
    expect(screen.queryByText("*")).toBeNull();
    expect(screen.queryByText("(partial data)")).toBeNull();
  });
});
