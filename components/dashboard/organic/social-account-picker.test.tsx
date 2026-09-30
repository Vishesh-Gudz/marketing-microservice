import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithOrg } from "@/tests/unit/dashboard-harness";
import { SOCIAL_ACCOUNT_ID_2, socialAccount } from "@/tests/unit/organic-fixtures";
import { SocialAccountPicker, socialAccountLabel } from "./social-account-picker";

describe("SocialAccountPicker", () => {
  const accounts = [
    socialAccount(),
    socialAccount({
      id: SOCIAL_ACCOUNT_ID_2,
      username: "mock_small",
      accountType: "creator",
      linked: false,
    }),
  ];

  it("is a labelled, keyboard-operable combobox showing the selected account", () => {
    renderWithOrg(
      <SocialAccountPicker
        accounts={accounts}
        selectedId={SOCIAL_ACCOUNT_ID_2}
        onSelect={vi.fn()}
      />,
    );
    const picker = screen.getByRole("combobox", { name: "Instagram account" });
    expect(picker).toHaveTextContent("@mock_small · Creator · unlinked");
    picker.focus();
    expect(picker).toHaveFocus();
  });

  it("shows a placeholder for an unknown selection and a note when the list is cut", () => {
    renderWithOrg(
      <SocialAccountPicker accounts={accounts} selectedId="acct_x" onSelect={vi.fn()} truncated />,
    );
    expect(screen.getByRole("combobox", { name: "Instagram account" })).toHaveTextContent(
      "Choose an account",
    );
    expect(screen.getByText("Showing the first 100 accounts.")).toBeInTheDocument();
  });

  it("labels accounts without a username by name", () => {
    expect(socialAccountLabel(socialAccount({ username: undefined, name: "Brand" }))).toBe(
      "Brand · Business",
    );
  });
});
