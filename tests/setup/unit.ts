import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { setDisplayLocale } from "@/lib/analytics/format";

// The dashboard formats with the browser locale; tests pin one for stable output.
setDisplayLocale("en-US");

afterEach(() => {
  cleanup();
});
