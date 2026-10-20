import type { NextConfig } from "next";

// Reconstructed from the shipped build (reports/06 §1, reports/09 §8).
// The upstream image hard-codes the container name `relayx`; this checkout uses
// loopback so it can run next to the replica backend.
const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:3000";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return {
      afterFiles: [
        { source: "/api/:path*", destination: `${BACKEND}/:path*` },
        { source: "/socket.io", destination: `${BACKEND}/socket.io` },
        { source: "/openapi.json", destination: `${BACKEND}/openapi.json` },
        { source: "/docs", destination: `${BACKEND}/docs` },
      ],
    };
  },
};

export default nextConfig;
