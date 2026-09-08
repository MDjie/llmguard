import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  distDir: ['.next-upgrade-v2', '.next-upgrade-build', '.next-comprehensive-build'].includes(process.env.GUARD_NEXT_DIST_DIR ?? '')
    ? process.env.GUARD_NEXT_DIST_DIR : '.next',
  allowedDevOrigins: ['*.dev.coze.site', '163.7.6.60', 'localhost'],
  // 生产构建使用 standalone 模式，优化部署大小和构建速度
  output: 'standalone',
  // 将 Node.js 原生模块标记为服务端专用
  serverExternalPackages: [
    'postgres', 'pg', 'drizzle-orm', 're2-wasm',
    'pdf-parse', '@napi-rs/canvas',
  ],
  // pdf-parse loads the platform Canvas binary through an optional runtime require.
  // Include only that pnpm package family so standalone images retain the active platform binary.
  outputFileTracingIncludes: {
    '/*': [
      'node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/*',
      'node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/*',
      'node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
  },
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
