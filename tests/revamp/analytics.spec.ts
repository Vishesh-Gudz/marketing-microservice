import { expect, settled, test, volatile } from "./support";

// The analytics workspaces (revamp Phase 7): the phone filter sheet and the chart's axes.

test.describe("phones", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("one Filters button opens the filters in a sheet, and changes apply at once", async ({
    page,
  }) => {
    await page.goto("/campaigns");
    await settled(page);
    const button = page.getByRole("button", { name: "Filters" });
    await expect(button).toContainText("Last 30 days · All accounts");
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    await expect(sheet.getByRole("combobox", { name: "Date range" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("filters-sheet-375.png", { mask: volatile(page) });

    await sheet.getByRole("combobox", { name: "Date range" }).click();
    await page.getByRole("option", { name: "Last 7 days" }).click();
    await expect(page).toHaveURL(/preset=last_7_days/);
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    await expect(button).toContainText("Last 7 days · All accounts");
  });
});

test.describe("large screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the chart's y axis is formatted for the metric", async ({ page }) => {
    await page.goto("/campaigns");
    await settled(page);
    // The first campaign is in USD, so its spend axis reads in dollars.
    await page.locator('main a[href^="/campaigns/"]').first().click();
    await settled(page);
    const chart = page.getByRole("img", { name: /Spend \(USD\) by day/ });
    await expect(chart).toBeVisible();
    // Only the y axis has text in dollars (the x axis holds dates).
    await expect(chart.getByText(/^\$\d+(\.\d)?K?$/).first()).toBeVisible();
  });
});
