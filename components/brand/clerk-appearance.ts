import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

type Appearance = NonNullable<ComponentProps<typeof ClerkProvider>["appearance"]>;

/**
 * Clerk's sign-in, sign-up, organization switcher, user menu and organization profile in the
 * Gudz palette and type (app/globals.css). Colours and fonts only: no Clerk element is hidden
 * or moved, so every Clerk flow keeps working exactly as before.
 */
export const CLERK_APPEARANCE: Appearance = {
  variables: {
    colorPrimary: "#0b7bb0",
    colorPrimaryForeground: "#ffffff",
    colorDanger: "#d14343",
    colorSuccess: "#1f8a5b",
    colorWarning: "#b7791f",
    colorNeutral: "#0f1115",
    colorForeground: "#0f1115",
    colorMuted: "#f6f7f9",
    colorMutedForeground: "#5f6672",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#0f1115",
    colorBorder: "#d6dae0",
    colorRing: "#0b7bb0",
    colorShadow: "#0f1115",
    colorModalBackdrop: "#0f1115",
    fontFamily: "var(--font-instrument), ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "var(--font-instrument), ui-sans-serif, system-ui, sans-serif",
    fontFamilyMono: "var(--font-jetbrains), ui-monospace, monospace",
    borderRadius: "0.625rem",
  },
};

/**
 * Clerk's sign-in, sign-up and choose-organization widgets inside the Gudz sign-in frame
 * (components/auth/auth-page.tsx): flat, at the form's width, without their own card. Their
 * header (title and subtitle) is left out because the frame's own heading says the same; every
 * field, button, link and the footer stay where Clerk puts them.
 */
export const CLERK_EMBEDDED: Appearance = {
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      maxWidth: "none",
      boxShadow: "none",
      border: "none",
      borderRadius: 0,
      background: "transparent",
    },
    card: {
      padding: 0,
      boxShadow: "none",
      border: "none",
      borderRadius: 0,
      background: "transparent",
      gap: "1.5rem",
    },
    header: { display: "none" },
    footer: { background: "transparent", padding: 0, marginTop: "1.5rem" },
    footerAction: { justifyContent: "flex-start", padding: 0 },
    // Button and field looks: app/globals.css (.gudz-clerk-*), which win over Clerk's styles.
    formButtonPrimary: "gudz-clerk-primary",
    socialButtonsBlockButton: "gudz-clerk-secondary",
    formFieldInput: "gudz-clerk-input",
  },
};
