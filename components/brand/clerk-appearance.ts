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
