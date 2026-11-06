import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, settled, test } from "./support";

// Accessibility baseline (axe, WCAG 2.2 A/AA). Today's violations are kept as text snapshots,
// so a change that adds a new kind of violation, or more affected elements, fails. Phases that
// fix issues update the snapshot and the diff shows what improved. The CI-safe specs in
// tests/e2e keep asserting that no serious or critical violation exists on the shell pages.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const ROUTES: { name: string; path: string; gate?: boolean }[] = [
  { name: "overview", path: "/" },
  { name: "campaigns", path: "/campaigns" },
  { name: "breakdowns", path: "/breakdowns" },
  { name: "conversions", path: "/conversions" },
  { name: "accounts", path: "/accounts" },
  { name: "social", path: "/social" },
  { name: "youtube", path: "/social?platform=youtube" },
  { name: "connections", path: "/connections" },
  { name: "inbox", path: "/inbox" },
  { name: "saved-replies", path: "/inbox/saved-replies" },
  { name: "whatsapp", path: "/whatsapp" },
  { name: "whatsapp-settings", path: "/whatsapp/settings" },
  { name: "whatsapp-templates", path: "/whatsapp/templates" },
  { name: "instagram-dms", path: "/instagram/messages" },
  { name: "instagram-dm-settings", path: "/instagram/messages/settings" },
  { name: "instagram-templates", path: "/instagram/messages/templates" },
  // Outside the dashboard (no org gate). In dev-token mode they show their "not used" state.
  { name: "sign-in", path: "/sign-in", gate: false },
  { name: "sign-up", path: "/sign-up", gate: false },
];

async function summary(page: Page): Promise<string> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const lines = result.violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? "n/a"}): ${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"} — ${v.help}`,
    )
    .sort();
  return lines.length ? `${lines.join("\n")}\n` : "no violations\n";
}

for (const route of ROUTES) {
  test(`axe: ${route.name}`, async ({ page }) => {
    await page.goto(route.path);
    await settled(page, { gate: route.gate !== false });
    expect(await summary(page)).toMatchSnapshot(`${route.name}.axe.txt`);
  });
}
