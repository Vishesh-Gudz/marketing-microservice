import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  INSTAGRAM_CLOSED,
  WHATSAPP_CLOSED,
  withInsightsPermissionMissing,
  withMessagingData,
} from "./fixtures";
import { expect, firstLink, settled, test } from "./support";

// Accessibility (axe: WCAG 2.2 A/AA plus axe's best practices). Each page or open state keeps
// its violations as a text snapshot, so a change that adds a new kind of violation, or more
// affected elements, fails; a phase that fixes one updates the snapshot. Phase 12 widened this
// to the detail pages, conversations, open forms, dialogs and sheets, the public pages and the
// phone width; every one is clean. The CI-safe specs in tests/e2e keep asserting that no serious
// or critical violation exists on the shell pages.
//
// One exclusion: the ⌘K results list scrolls without being a tab stop, by design (the WAI-ARIA
// combobox pattern: the arrow keys reach and scroll to every option; see command-palette.tsx),
// so it is left out of axe's "scrollable region must be focusable" check.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

type Case = {
  name: string;
  path: string | ((page: Page) => Promise<string>);
  /** Outside the dashboard: no org gate to wait for. */
  gate?: boolean;
  /** Answer the messaging queries with the made-up data of fixtures.ts. */
  data?: boolean;
  /** With `data`: changes to the open WhatsApp conversation. */
  whatsapp?: Record<string, unknown>;
  /** With `data`: changes to the open Instagram conversation. */
  instagram?: Record<string, unknown>;
  /** Other socket answers (fixtures.ts), set up before the page loads. */
  answers?: (page: Page) => Promise<void>;
  /** Open a form, dialog or sheet before the check. */
  open?: (page: Page) => Promise<void>;
};

/** Opens a conversation's details sheet (from the right, or the bottom on phones). */
async function openDetails(page: Page) {
  await page.getByRole("button", { name: "Details" }).click();
  await page.getByRole("dialog").waitFor();
}

const ROUTES: Case[] = [
  { name: "overview", path: "/" },
  { name: "campaigns", path: "/campaigns" },
  { name: "campaign", path: firstLink("/campaigns", 'main a[href^="/campaigns/"]') },
  { name: "breakdowns", path: "/breakdowns" },
  { name: "conversions", path: "/conversions" },
  { name: "accounts", path: "/accounts" },
  { name: "social", path: "/social" },
  { name: "social-post", path: firstLink("/social", 'main a[href^="/social/posts/"]') },
  { name: "youtube", path: "/social?platform=youtube" },
  { name: "connections", path: "/connections" },
  { name: "organization", path: "/organization" },
  { name: "inbox", path: "/inbox" },
  { name: "saved-replies", path: "/inbox/saved-replies" },
  { name: "whatsapp", path: "/whatsapp" },
  { name: "whatsapp-settings", path: "/whatsapp/settings" },
  { name: "whatsapp-templates", path: "/whatsapp/templates" },
  { name: "instagram-dms", path: "/instagram/messages" },
  { name: "instagram-dm-settings", path: "/instagram/messages/settings" },
  { name: "instagram-templates", path: "/instagram/messages/templates" },
  { name: "dashboard-not-found", path: "/campaigns/not-a-real-campaign" },
  // With made-up conversations, saved replies, templates and accounts.
  { name: "inbox-threads", path: "/inbox", data: true },
  { name: "whatsapp-conversation", path: "/whatsapp/conversations/demo", data: true },
  {
    name: "instagram-conversation",
    path: "/instagram/messages/conversations/demo",
    data: true,
  },
  { name: "saved-replies-list", path: "/inbox/saved-replies", data: true },
  { name: "instagram-templates-list", path: "/instagram/messages/templates", data: true },
  { name: "whatsapp-settings-accounts", path: "/whatsapp/settings", data: true },
  { name: "instagram-dm-settings-accounts", path: "/instagram/messages/settings", data: true },
  // Outside the dashboard (no org gate). In dev-token mode the Clerk pages show their
  // "not used" state.
  { name: "sign-in", path: "/sign-in", gate: false },
  { name: "sign-up", path: "/sign-up", gate: false },
  { name: "choose-organization", path: "/session-tasks/choose-organization", gate: false },
  { name: "privacy", path: "/privacy", gate: false },
  { name: "data-deletion", path: "/data-deletion", gate: false },
  { name: "root-not-found", path: "/this-page-does-not-exist", gate: false },
];

const STATES: Case[] = [
  {
    name: "saved-reply-form",
    path: "/inbox/saved-replies",
    data: true,
    open: (page) => page.getByRole("button", { name: "New saved reply" }).click(),
  },
  {
    name: "saved-reply-starters",
    path: "/inbox/saved-replies",
    data: true,
    open: (page) => page.getByRole("button", { name: "Ready-made replies" }).click(),
  },
  {
    name: "saved-reply-delete",
    path: "/inbox/saved-replies",
    data: true,
    open: (page) =>
      page
        .getByRole("listitem", { name: "Opening hours" })
        .getByRole("button", { name: "Delete" })
        .click(),
  },
  {
    name: "instagram-template-builder",
    path: "/instagram/messages/templates",
    data: true,
    open: (page) => page.getByRole("button", { name: "New template" }).click(),
  },
  {
    name: "whatsapp-template-builder",
    path: "/whatsapp/templates",
    data: true,
    open: async (page) => {
      await page.getByRole("button", { name: "New template" }).click();
      await page.getByRole("button", { name: "Start from scratch" }).click();
    },
  },
  {
    name: "conversation-details-sheet",
    path: "/whatsapp/conversations/demo",
    data: true,
    open: openDetails,
  },
  {
    name: "whatsapp-conversation-closed",
    path: "/whatsapp/conversations/demo",
    data: true,
    whatsapp: WHATSAPP_CLOSED,
  },
  {
    name: "instagram-conversation-closed",
    path: "/instagram/messages/conversations/demo",
    data: true,
    instagram: INSTAGRAM_CLOSED,
  },
  {
    // The second fixture number is not registered yet: replies unavailable (D-M3).
    name: "whatsapp-conversation-unavailable",
    path: "/whatsapp/conversations/demo",
    data: true,
    whatsapp: { phoneNumberId: "100000000000012" },
  },
  {
    name: "conversation-saved-replies",
    path: "/whatsapp/conversations/demo",
    data: true,
    open: async (page) => {
      await page.getByRole("button", { name: "Saved replies" }).click();
      await page.getByRole("list", { name: "Saved replies for this channel" }).waitFor();
    },
  },
  {
    name: "page-search",
    path: "/",
    open: async (page) => {
      await page.keyboard.press("Control+k");
      await page.getByRole("dialog").waitFor();
    },
  },
  // O2: an Instagram account that cannot sync without instagram_manage_insights.
  { name: "social-insights-permission", path: "/social", answers: withInsightsPermissionMissing },
];

const PHONE: Case[] = [
  { name: "overview", path: "/" },
  { name: "inbox-threads", path: "/inbox", data: true },
  { name: "whatsapp-conversation", path: "/whatsapp/conversations/demo", data: true },
  {
    name: "instagram-conversation",
    path: "/instagram/messages/conversations/demo",
    data: true,
  },
  {
    name: "conversation-details-sheet",
    path: "/whatsapp/conversations/demo",
    data: true,
    open: openDetails,
  },
  {
    name: "whatsapp-conversation-closed",
    path: "/whatsapp/conversations/demo",
    data: true,
    whatsapp: WHATSAPP_CLOSED,
  },
  { name: "instagram-templates-list", path: "/instagram/messages/templates", data: true },
  { name: "social-insights-permission", path: "/social", answers: withInsightsPermissionMissing },
  {
    name: "menu-sheet",
    path: "/",
    open: async (page) => {
      await page
        .getByRole("button", { name: /Open menu/ })
        .first()
        .click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "filters-sheet",
    path: "/campaigns",
    open: async (page) => {
      await page
        .getByRole("button", { name: /Filters/ })
        .first()
        .click();
      await page.getByRole("dialog").waitFor();
    },
  },
];

async function summary(page: Page): Promise<string> {
  const result = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude("[data-palette-results]")
    .analyze();
  const lines = result.violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? "n/a"}): ${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"} — ${v.help}`,
    )
    .sort();
  return lines.length ? `${lines.join("\n")}\n` : "no violations\n";
}

async function check(page: Page, c: Case, file: string) {
  if (c.data) await withMessagingData(page, c.whatsapp, c.instagram);
  if (c.answers) await c.answers(page);
  const path = typeof c.path === "string" ? c.path : await c.path(page);
  await page.goto(path);
  if (c.name.endsWith("not-found")) {
    await expect(page.getByText(/not found/i).first()).toBeVisible();
  } else {
    await settled(page, { gate: c.gate !== false });
  }
  if (c.open) {
    await c.open(page);
    // Let the opening transition finish (animations are frozen, transitions are not).
    await page.waitForTimeout(300);
  }
  expect(await summary(page)).toMatchSnapshot(file);
}

for (const c of [...ROUTES, ...STATES]) {
  test(`axe: ${c.name}`, async ({ page }) => {
    await check(page, c, `${c.name}.axe.txt`);
  });
}

test.describe("wide", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  // The details column beside the conversation (≥1536 px).
  test("axe at 1920 px: whatsapp-conversation", async ({ page }) => {
    await check(
      page,
      { name: "whatsapp-conversation", path: "/whatsapp/conversations/demo", data: true },
      "whatsapp-conversation-1920.axe.txt",
    );
  });
});

test.describe("viewer", () => {
  test.use({ role: "viewer" });
  // The Reporting card without its form (C1).
  test("axe as a viewer: organization", async ({ page }) => {
    await check(
      page,
      { name: "organization", path: "/organization" },
      "organization-viewer.axe.txt",
    );
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  for (const c of PHONE) {
    test(`axe at 375 px: ${c.name}`, async ({ page }) => {
      await check(page, c, `${c.name}-375.axe.txt`);
    });
  }
});
