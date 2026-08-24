import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Collector state lives in ./.data; Claude's own files are only ever read.
  outputFileTracingExcludes: { "*": [".data/**"] },
};

export default nextConfig;
