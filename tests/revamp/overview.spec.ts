import type { Page } from "@playwright/test";
import { expect, settled, test, volatile } from "./support";

// The Overview briefing (revamp Phase 6): what needs attention comes first, then the key
// metrics; an organization without ad accounts gets one prompt instead of empty regions.

const AD_ACCOUNTS = "v1/adAccounts:list";

/**
 * Answer `v1/adAccounts:list` with an empty list, as for an organization that has not linked
 * an ad account yet. Every other message passes through to the local backend unchanged.
 */
async function withoutAdAccounts(page: Page) {
  await page.routeWebSocket(/\/api\/[^/]+\/sync/, (ws) => {
    const server = ws.connectToServer();
    const queryIds = new Set<number>();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes(AD_ACCOUNTS)) {
        const parsed = JSON.parse(message) as {
          type?: string;
          modifications?: { type?: string; queryId?: number; udfPath?: string }[];
        };
        if (parsed.type === "ModifyQuerySet") {
          for (const change of parsed.modifications ?? []) {
            if (change.type === "Add" && change.udfPath === AD_ACCOUNTS) {
              queryIds.add(change.queryId!);
            }
          }
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === "string" && queryIds.size > 0 && message.includes("QueryUpdated")) {
        const parsed = JSON.parse(message) as {
          type?: string;
          modifications?: { type?: string; queryId?: number; value?: unknown }[];
        };
        if (parsed.type === "Transition") {
          for (const change of parsed.modifications ?? []) {
            if (change.type === "QueryUpdated" && queryIds.has(change.queryId!)) change.value = [];
          }
          ws.send(JSON.stringify(parsed));
          return;
        }
      }
      ws.send(message);
    });
  });
}

test.describe("large screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("what needs attention sits between the filters and the key metrics", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    const attention = page.getByRole("region", { name: "Needs attention" });
    const metrics = page.getByRole("region", { name: "Key metrics" });
    // The seeded accounts have unsynced days and currencies without exchange rates.
    await expect(attention.getByRole("status", { name: "Partial data" })).toBeVisible();
    await expect(
      attention.getByRole("status", { name: "Currency conversion incomplete" }),
    ).toBeVisible();
    await expect(metrics.locator("[data-kpi]")).toHaveCount(10);
    const top = async (locator: typeof metrics) => (await locator.boundingBox())!.y;
    expect(await top(page.getByTestId("resolved-range"))).toBeLessThan(await top(attention));
    expect(await top(attention)).toBeLessThan(await top(metrics));
  });
});

for (const viewport of [
  { name: "1440", width: 1440, height: 900 },
  { name: "375", width: 375, height: 812 },
]) {
  test.describe(`${viewport.name} px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("an organization without ad accounts gets one prompt to connect", async ({ page }) => {
      await withoutAdAccounts(page);
      await page.goto("/");
      await settled(page);
      await expect(page.getByRole("heading", { name: "No ad accounts linked yet" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to Connections" })).toHaveAttribute(
        "href",
        "/connections",
      );
      await expect(page.getByRole("region", { name: "Key metrics" })).toHaveCount(0);
      await expect(page.getByTestId("resolved-range")).toHaveCount(0);
      await expect(page).toHaveScreenshot(`overview-no-ad-accounts-${viewport.name}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });
  });
}
