import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

export type Role = "viewer" | "editor" | "admin";

/** Where global-setup.ts writes the viewer and editor tokens (git-ignored). */
export const TOKENS_PATH = join(process.cwd(), "test-results", "revamp", "role-tokens.json");

/**
 * The browser's "now" for every spec: Wednesday 4 November 2026, 12:00 UTC. Presets such as
 * "Last 30 days" resolve against it, so the seeded mock data for that window renders the same
 * on every run (the data for past days is fixed once synced).
 */
export const NOW = new Date("2026-11-04T12:00:00.000Z");

function roleToken(role: Exclude<Role, "admin">): string {
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as Record<string, string>;
  const token = tokens[role];
  if (!token) throw new Error(`No ${role} token; global-setup.ts did not run.`);
  return token;
}

/**
 * `test` with the clock frozen and, for `role: "viewer" | "editor"`, the Convex identity
 * swapped. The dashboard's dev token is compiled into the dev build (admin), so the fixture
 * rewrites the token inside the Convex client's `Authenticate` message on the sync WebSocket.
 * Everything else goes to the real local backend unchanged, so the org gate, `orgs.me` and
 * every permission check run exactly as they do for a real member with that role.
 */
export const test = base.extend<{ role: Role }>({
  role: ["admin", { option: true }],
  // The fixture callback is named `provide`, not Playwright's usual `use`, so the React hooks
  // lint rule does not mistake it for a hook.
  page: async ({ page, role }, provide) => {
    await page.clock.setFixedTime(NOW);
    if (role !== "admin") {
      const token = roleToken(role);
      await page.routeWebSocket(/\/api\/[^/]+\/sync/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
          if (typeof message === "string" && message.includes('"Authenticate"')) {
            const parsed = JSON.parse(message) as {
              type?: string;
              tokenType?: string;
              value?: string;
            };
            if (parsed.type === "Authenticate" && parsed.tokenType === "User") parsed.value = token;
            server.send(JSON.stringify(parsed));
            return;
          }
          server.send(message);
        });
      });
    }
    await provide(page);
  },
});

export { expect };

/** Wait until the org gate is ready and no skeleton or "Updating…" marker is left. */
export async function settled(page: Page, { gate = true }: { gate?: boolean } = {}): Promise<void> {
  // The local backend plus on-demand compiles can keep "Connecting to Convex…" up for a while
  // on the first visit of a page.
  if (gate) await expect(page.getByTestId("org-badge")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("[data-slot=skeleton]")).toHaveCount(0);
  await expect(page.getByText("Updating…")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Masked in every screenshot:
 * - text that changes with background syncs (freshness notes, "last synced");
 * - real provider data. A local backend used for real OAuth testing can hold real Google Ads
 *   accounts discovered by a connection (names and customer ids, shown in the radio-table
 *   picker on /connections) and real channel or account ids. This repository is public, so
 *   those never go into a committed baseline.
 */
export function volatile(page: Page): Locator[] {
  return [
    page.getByTestId("freshness"),
    page.getByTestId("youtube-freshness"),
    page.getByText(/last synced|synced through|data through/i),
    page.locator("main table").filter({ has: page.getByRole("radio") }),
    page.getByText(/\b\d{3}-\d{3}-\d{4}\b/),
    page.getByText(/\bUC[\w-]{22}\b/),
  ];
}
