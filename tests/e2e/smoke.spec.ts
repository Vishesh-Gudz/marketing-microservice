import { expect, test } from "@playwright/test";

test("home page renders the dashboard shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Marketing Microservice/);
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
  // Either "Connecting to Convex…" (no backend, e.g. CI) or "Convex: <service>".
  await expect(page.getByText(/Convex/).last()).toBeVisible();
});
