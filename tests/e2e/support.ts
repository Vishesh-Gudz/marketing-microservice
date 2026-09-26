import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** `npm run dev:auth setup` wrote a dashboard token (local development only, never CI). */
export function localDevAuthConfigured(): boolean {
  if (process.env.CI) return false;
  const envPath = join(process.cwd(), ".env.local");
  return (
    existsSync(envPath) && /^NEXT_PUBLIC_DEV_AUTH_TOKEN=.+$/m.test(readFileSync(envPath, "utf8"))
  );
}

/** Serious and critical axe violations (WCAG 2.x A/AA rules) on the current page. */
export async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
  expect(serious).toEqual([]);
}
