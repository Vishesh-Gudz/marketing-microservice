import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// The WhatsApp inbox and settings pages (ADR 0013, ADR 0014 B3) as an admin, LOCAL ONLY and
// opt-in: needs a running local Convex backend and `npm run dev:auth setup` (org "dev-org",
// role "admin"), then
//   E2E_WHATSAPP_PAGE=1 npx playwright test whatsapp
// Every request to Meta is blocked and recorded, so nothing here ever reaches Meta: the real
// signup needs the Meta configuration in docs/whatsapp.md and is a separate, manual test.

test.skip(
  !localDevAuthConfigured() || process.env.E2E_WHATSAPP_PAGE !== "1",
  "local-only: E2E_WHATSAPP_PAGE=1 with a local backend and npm run dev:auth setup",
);

const META_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(facebook\.(com|net)|fbcdn\.net)\//;

test("shows an admin the WhatsApp inbox, then its settings, without ever reaching Meta", async ({
  page,
}) => {
  const metaRequests: string[] = [];
  await page.route(META_HOSTS, async (route) => {
    metaRequests.push(new URL(route.request().url()).host);
    await route.abort();
  });

  await page.goto("/whatsapp");
  await expect(page.getByRole("heading", { level: 1, name: "WhatsApp" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("org-badge")).toContainText("admin", { timeout: 20_000 });
  await expect(
    page.getByRole("list", { name: "Conversations" }).or(page.getByText("No conversations yet")),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoSeriousA11yViolations(page);
  expect(metaRequests).toEqual([]); // the inbox never loads Meta's SDK

  await page.getByRole("link", { name: "WhatsApp settings" }).first().click();
  await expect(page).toHaveURL(/\/whatsapp\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "WhatsApp settings" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { level: 2, name: "Connected accounts" })).toBeVisible();

  // A local backend without the Meta app settings reports WhatsApp as unavailable and the SDK
  // is never requested; with them, the (blocked) SDK fails visibly and nothing can start.
  const unavailable = page.getByLabel("WhatsApp is not available yet");
  const blocked = page.getByLabel("Meta sign-in could not load");
  await expect(unavailable.or(blocked)).toBeVisible({ timeout: 20_000 });
  if (await unavailable.isVisible()) {
    expect(metaRequests).toEqual([]);
  } else {
    expect(metaRequests).toEqual(["connect.facebook.net"]);
  }
  await expect(page.getByRole("button", { name: "Connect WhatsApp" })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});
