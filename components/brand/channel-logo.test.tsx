import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlatformName } from "@/components/dashboard/platform-name";
import { CHANNEL_LOGO_NAMES, ChannelLogo, isChannelLogoName } from "./channel-logo";

// Kinso K1: the integrations' colour marks.

describe("ChannelLogo", () => {
  it("is decorative next to a written name, and an image with a name when alone", () => {
    const { container } = render(<ChannelLogo channel="whatsapp" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();

    render(<ChannelLogo channel="google_ads" label="Google Ads" />);
    expect(screen.getByRole("img", { name: "Google Ads" })).toBeInTheDocument();
  });

  it("draws each mark in its brand colours", () => {
    const fills = (channel: Parameters<typeof ChannelLogo>[0]["channel"]) => {
      const { container } = render(<ChannelLogo channel={channel} />);
      return [...container.querySelectorAll("path")].map((path) => path.getAttribute("fill"));
    };
    expect(fills("whatsapp")).toEqual(["#25D366"]);
    expect(fills("google_ads")).toEqual(["#FBBC04", "#4285F4", "#34A853"]);
    expect(fills("meta")).toEqual(["#0081FB"]);
    expect(fills("youtube")).toEqual(["#FF0000", "#FFFFFF"]);
    // Instagram's glyph is filled with its own gradient, one per logo on the page.
    const { container } = render(<ChannelLogo channel="instagram" />);
    const gradient = container.querySelector("radialGradient")!;
    expect(container.querySelector("path")).toHaveAttribute("fill", `url(#${gradient.id})`);
  });

  it("knows the five integrations by their platform keys", () => {
    expect(Object.keys(CHANNEL_LOGO_NAMES)).toEqual([
      "whatsapp",
      "instagram",
      "google_ads",
      "meta",
      "youtube",
    ]);
    expect(isChannelLogoName("meta")).toBe(true);
    expect(isChannelLogoName("tiktok")).toBe(false);
  });
});

describe("PlatformName", () => {
  it("puts the logo before a known platform's name, and shows others as their name", () => {
    const { container } = render(<PlatformName platform="google_ads" />);
    expect(container).toHaveTextContent("Google Ads");
    expect(container.querySelector("svg")).not.toBeNull();

    const other = render(<PlatformName platform="audience_network" />);
    expect(other.container).toHaveTextContent("Audience Network");
    expect(other.container.querySelector("svg")).toBeNull();
  });
});
