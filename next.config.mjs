// Plain ESM rather than TypeScript on purpose: Next auto-installs the typescript
// package at runtime when it loads a .ts config, which would mean a network fetch
// and a write into the install directory on a user's first run. The JSDoc type
// gives the same editor autocomplete without that cost.

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Collector state lives in ~/.contextclues; Claude's own files are only ever read.
  outputFileTracingExcludes: { "*": [".data/**"] },
};

export default nextConfig;
