import { expect, type Role, settled, test } from "./support";

// What a viewer, an editor and an admin of the same organization can see and do, before the
// revamp moves anything. The identity is swapped at the Convex protocol level (support.ts),
// so these are the server's own answers for each role.

const ROLES: Role[] = ["viewer", "editor", "admin"];

for (const role of ROLES) {
  test.describe(role, () => {
    test.use({ role });
    const editorPlus = role !== "viewer";
    const admin = role === "admin";

    test("header shows the role from the server", async ({ page }) => {
      await page.goto("/");
      await settled(page);
      await expect(page.getByTestId("org-badge")).toContainText(role);
    });

    test("channels: only admins connect or disconnect", async ({ page }) => {
      await page.goto("/connections");
      await settled(page);
      // Connect / Reconnect / Disconnect, whichever applies to each provider's state.
      const actions = page.getByRole("button", {
        name: /^(Connect|Reconnect|Disconnect) (Google Ads|Meta Ads|YouTube|Instagram)/,
      });
      if (admin) await expect(actions.first()).toBeVisible();
      else await expect(actions).toHaveCount(0);
    });

    test("saved replies: editors and admins write", async ({ page }) => {
      await page.goto("/inbox/saved-replies");
      await settled(page);
      await expect(page.getByRole("button", { name: "New saved reply" })).toHaveCount(
        editorPlus ? 1 : 0,
      );
    });

    test("Instagram templates: editors and admins write", async ({ page }) => {
      await page.goto("/instagram/messages/templates");
      await settled(page);
      await expect(page.getByRole("button", { name: "New template" })).toHaveCount(
        editorPlus ? 1 : 0,
      );
    });

    test("WhatsApp settings: only admins connect a number", async ({ page }) => {
      await page.goto("/whatsapp/settings");
      await settled(page);
      // Locally the WhatsApp deployment flag is usually off ("WhatsApp is not available yet");
      // then nobody gets the connect buttons and there is nothing role-specific to check.
      const unavailable = await page.getByText("WhatsApp is not available yet").count();
      test.skip(unavailable > 0, "WhatsApp connections are not enabled on this local deployment");
      await expect(page.getByRole("button", { name: "Connect a new number" })).toHaveCount(
        admin ? 1 : 0,
      );
    });

    test("organization page renders for every role", async ({ page }) => {
      await page.goto("/organization");
      await settled(page);
      // Dev-token builds show an explanation instead of Clerk's organization profile.
      await expect(page).toHaveTitle("Organization · Gudz Marketing");
      await expect(page.locator("main")).toContainText(/Organization/);
    });

    test("reporting settings: only admins change them (C1)", async ({ page }) => {
      await page.goto("/organization#reporting");
      await settled(page);
      const card = page.getByRole("region", { name: "Reporting" });
      await expect(card).toBeVisible();
      // The seed pins the dev organization to USD and UTC. Nothing is saved here.
      if (admin) {
        await expect(card.getByRole("combobox", { name: "Reporting currency" })).toHaveValue("USD");
        await expect(card.getByRole("combobox", { name: "Time zone" })).toHaveValue("UTC");
        await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
      } else {
        await expect(card.getByRole("combobox")).toHaveCount(0);
        await expect(card).toContainText("Only admins can change these.");
      }
    });
  });
}
