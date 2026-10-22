import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./support";

// Regression for a flaky color-contrast failure: the header's Convex status badge switches from
// "Connecting to Convex…" (outline) to "Convex: …" (dark background) as soon as the backend
// answers. With a color transition, a scan landing mid-fade measured an intermediate text color.
// The badge now swaps instantly. These scans run repeatedly WHILE the badge changes state when a
// local Convex backend is reachable (local runs); in CI (no backend) the badge stays in its
// connecting state and the same scans still run.

const LOADS = 5;
const SCANS_PER_LOAD = 12;

test("the Convex status badge never fails color contrast while it changes state", async ({
  page,
}) => {
  // 5 loads x 12 scans: each axe scan takes a few hundred milliseconds.
  test.setTimeout(180_000);
  const failures: string[] = [];
  const states = new Set<string>();
  for (let load = 1; load <= LOADS; load++) {
    await page.goto("/conversions");
    for (let scan = 1; scan <= SCANS_PER_LOAD; scan++) {
      const badge = page.locator('header [data-slot="badge"]', { hasText: /Convex/ }).first();
      states.add((await badge.textContent().catch(() => null)) ?? "(not rendered yet)");
      const results = await new AxeBuilder({ page })
        .include("header")
        .withRules(["color-contrast"])
        .analyze();
      for (const violation of results.violations) {
        for (const node of violation.nodes)
          failures.push(`load ${load} scan ${scan}: ${node.html}`);
      }
    }
  }
  test.info().annotations.push({ type: "badge states seen", description: [...states].join(" | ") });
  expect(failures).toEqual([]);
});

// Deterministic version of the same regression: an observer installed before the page loads
// measures the badge's text against its background at the exact moment it switches to the
// connected state (when a color transition would start from the old, dark text). Needs a
// reachable local Convex backend to see the switch; skipped otherwise (e.g. CI).
test("the status badge is readable at the very moment it switches state", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    type Sample = { text: string; ratio: number; transition: string };
    const samples: Sample[] = [];
    (window as unknown as { __badgeSamples: Sample[] }).__badgeSamples = samples;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgb = (css: string): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const luminance = ([r, g, b]: [number, number, number]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const measure = () => {
      for (const el of document.querySelectorAll<HTMLElement>('header [data-slot="badge"]')) {
        const text = el.textContent ?? "";
        if (!text.startsWith("Convex:")) continue;
        const style = getComputedStyle(el);
        const [l1, l2] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))];
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        samples.push({ text, ratio: Math.round(ratio * 100) / 100, transition: style.transition });
      }
    };
    new MutationObserver(measure).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  });
  await page.goto("/conversions");
  const connected = page.locator('header [data-slot="badge"]', { hasText: "Convex:" }).first();
  const switched = await connected
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!switched, "no reachable Convex backend: the badge never switches state");
  const samples = await page.evaluate(
    () => (window as unknown as { __badgeSamples: unknown[] }).__badgeSamples,
  );
  expect(samples.length).toBeGreaterThan(0);
  // WCAG AA for this text size: 4.5:1, at the first moment the connected state exists.
  for (const sample of samples as { ratio: number }[]) {
    expect(sample.ratio).toBeGreaterThanOrEqual(4.5);
  }
});

test("color-contrast violations elsewhere on the page are still detected", async ({ page }) => {
  await page.goto("/conversions");
  await page.locator("header").waitFor();
  // A deliberately unreadable element: light gray on white (contrast about 1.6). Appended
  // directly to <body>, which React 19 tolerates (it skips unexpected body/head nodes, as
  // with browser extensions), so it never causes a hydration mismatch.
  await page.evaluate(() => {
    const probe = document.createElement("p");
    probe.id = "contrast-probe";
    probe.textContent = "Low contrast probe";
    probe.style.cssText = "color:#cccccc;background:#ffffff;font-size:14px;padding:4px";
    document.body.append(probe);
  });
  await expect(page.locator("#contrast-probe")).toBeVisible();
  const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  const targets = results.violations.flatMap((v) => v.nodes.flatMap((n) => n.target.map(String)));
  expect(targets).toContain("#contrast-probe");
  // The suite's own helper (all WCAG A/AA rules, no exclusions) flags it as well.
  await expect(expectNoSeriousA11yViolations(page)).rejects.toThrow(/color-contrast/);
});
