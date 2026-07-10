import type { NextConfig } from "next";

// 純粋なリバースプロキシ。ページは持たず、app/[[...path]]/route.ts の
// ルートハンドラだけで全リクエストを非公開 Cloud Run へ転送する。
const nextConfig: NextConfig = {};

export default nextConfig;
