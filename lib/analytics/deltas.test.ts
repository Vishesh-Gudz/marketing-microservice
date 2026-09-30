import { describe, expect, it } from "vitest";
import { deltaTone, deltaView } from "./deltas";

describe("delta tone", () => {
  it("higher is better for volume and ratio metrics", () => {
    expect(deltaTone("clicks", 0.1)).toBe("positive");
    expect(deltaTone("roas", -0.1)).toBe("negative");
  });

  it("lower is better for cost metrics", () => {
    for (const metric of ["cpc", "cpm", "costPerConversion", "costPerAction"]) {
      expect(deltaTone(metric, -0.1)).toBe("positive");
      expect(deltaTone(metric, 0.1)).toBe("negative");
    }
  });

  it("spend and unchanged values are neutral", () => {
    expect(deltaTone("spend", 0.5)).toBe("neutral");
    expect(deltaTone("clicks", 0)).toBe("neutral");
  });
});

describe("deltaView", () => {
  it("shows the relative change", () => {
    expect(deltaView("clicks", { percent: 0.25, absolute: 5 }, "en-US")).toEqual({
      kind: "change",
      text: "+25.0%",
      absoluteText: "+5",
      direction: "up",
      tone: "positive",
      partial: false,
    });
    expect(deltaView("cpc", { percent: -0.1, partial: true }, "en-US")).toMatchObject({
      tone: "positive",
      direction: "down",
      partial: true,
    });
  });

  it("formats the absolute change in the metric's unit", () => {
    expect(
      deltaView(
        "spend",
        {
          percent: 0.1,
          absolute: { native: [], reporting: { currency: "USD", micros: "12500000" } },
        },
        "en-US",
      ),
    ).toMatchObject({ absoluteText: "+$12.50", text: "+10.0%" });
    expect(
      deltaView(
        "cpc",
        { percent: -0.1, absolute: { native: [{ currency: "EUR", micros: "-500000" }] } },
        "en-US",
      ),
    ).toMatchObject({ absoluteText: "-€0.50" });
    expect(deltaView("ctr", { percent: 0.1, absolute: 0.0025 }, "en-US")).toMatchObject({
      absoluteText: "+0.25 pp",
    });
    // Several currencies without a reporting value: no single absolute change.
    expect(
      deltaView("spend", {
        percent: 0.1,
        absolute: {
          native: [
            { currency: "EUR", micros: "1" },
            { currency: "USD", micros: "1" },
          ],
        },
      }),
    ).not.toHaveProperty("absoluteText");
  });

  it("explains every reason", () => {
    expect(deltaView("clicks", { reason: "previous_zero" })).toMatchObject({
      kind: "reason",
      text: "New (no previous value)",
    });
    expect(deltaView("clicks", { reason: "previous_unavailable" })).toMatchObject({
      text: "No comparison data",
    });
    expect(deltaView("spend", { reason: "mixed_currency" })).toMatchObject({
      text: "Currencies differ",
    });
  });

  it("renders nothing when the delta is omitted", () => {
    expect(deltaView("clicks", undefined)).toEqual({ kind: "none" });
  });
});
