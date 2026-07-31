import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // packages/shared ships raw TS on purpose — no build step for a types+schemas package.
  transpilePackages: ["@capso/shared"],
};

export default nextConfig;
