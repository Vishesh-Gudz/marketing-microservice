import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Playwright and the local Convex setup use 127.0.0.1 rather than localhost.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
