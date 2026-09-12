import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both routes prerender with no server work, so the whole app ships as
  // static files. This is what makes it deployable to Cloudflare's asset
  // hosting with no Workers runtime or Next.js adapter involved.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
