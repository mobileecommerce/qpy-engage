import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const isPagesBuild = Boolean(basePath);

const nextConfig: NextConfig = {
  output: isPagesBuild ? "export" : undefined,
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: isPagesBuild,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: isPagesBuild },
};

export default nextConfig;
