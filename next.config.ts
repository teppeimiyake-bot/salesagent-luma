import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ワークスペースルートを明示（親ディレクトリの lockfile による誤検出を防ぐ。
  // 親パスに非ASCII文字が含まれると Turbopack がパニックするため必須）。
  turbopack: {
    root: __dirname,
  },
  // middleware/proxy があるとリクエストボディがバッファされる。
  // デフォルト 10MB だと画面録画(mp4)が途中切断され、POST /api/meetings が 500 になる。
  experimental: {
    // 他 API 向け。大容量の POST /api/meetings は middleware matcher 除外でバッファ回避。
    proxyClientMaxBodySize: "1024mb",
    serverActions: {
      bodySizeLimit: "1024mb",
    },
  },
  // Vercel 本番では <project>.public.blob.vercel-storage.com から画像を読み込むため
  // next/image を使う場合に備えてリモートホストを許可しておく。
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
      { protocol: "https", hostname: "*.blob.vercel-storage.com" },
    ],
  },
  // Prisma を server external として扱う（Vercel ビルド時の最適化に効く）
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
