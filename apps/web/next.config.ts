import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pi 及其内部包是 ESM Node 目标，避免被 webpack/turbopack 打包
  serverExternalPackages: [
    '@aidocs/api',
    '@aidocs/archify',
    '@aidocs/agents',
    '@aidocs/core',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-mcp',
  ],
};
export default nextConfig;
