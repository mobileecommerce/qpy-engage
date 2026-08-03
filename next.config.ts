import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// Static export used to be inferred from having a basePath, which conflated two separate things:
// "this is a static build" and "this is served from a subfolder". A site on its own domain is the
// first without being the second, and inferring one from the other silently produced no `out/` at
// all. STATIC_EXPORT states the intent; a basePath still implies it, so existing builds are unchanged.
const isStaticExport = process.env.STATIC_EXPORT === "1" || Boolean(basePath);

const nextConfig: NextConfig = {
  output: isStaticExport ? "export" : undefined,
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: isStaticExport,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: isStaticExport },
};

export default nextConfig;
