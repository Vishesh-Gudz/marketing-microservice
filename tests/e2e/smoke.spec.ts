import { expect, test } from "@playwright/test";

test("home page renders the service shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Marketing Microservice");
  await expect(page.getByRole("heading", { name: "Marketing Microservice" })).toBeVisible();
  // Either "Connecting to Convex…" (no backend, e.g. CI) or "Convex: <service>".
  await expect(page.getByText(/Convex/).last()).toBeVisible();
});
