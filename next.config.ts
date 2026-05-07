import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
