import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: ['*.dev.coze.site', '163.7.6.60', 'localhost'],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // 生产构建使用 standalone 模式，优化部署大小和构建速度
  output: 'standalone',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
  // 将 Node.js 原生模块标记为服务端专用
  serverExternalPackages: ['postgres', 'pg', 'drizzle-orm'],
  // 空的 turbopack 配置，允许使用 webpack 配置（Next.js 16 默认 Turbopack）
  turbopack: {},
  // 确保这些模块不会被 Webpack 打包到客户端
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // 在客户端构建时，将这些模块替换为空对象
      config.resolve.alias = {
        ...config.resolve.alias,
        'postgres': false,
        'pg': false,
      };
    }
    return config;
  },
};

export default nextConfig;
