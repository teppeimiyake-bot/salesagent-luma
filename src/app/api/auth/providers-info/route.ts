/**
 * クライアントから「Googleログインが有効か？」を確認するための軽量API。
 * NextAuth標準の /api/auth/providers でも分かるが、middlewareの介在を避けるため独立。
 */
import { NextResponse } from "next/server";
import { isGoogleAuthEnabled } from "@/auth";

export async function GET() {
  return NextResponse.json({ google: isGoogleAuthEnabled });
}
