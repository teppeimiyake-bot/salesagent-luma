/**
 * クライアントから「Googleログインが有効か？」「招待なしの登録を受け付けるか？」を確認するための軽量API。
 * NextAuth標準の /api/auth/providers でも分かるが、middlewareの介在を避けるため独立。
 */
import { NextResponse } from "next/server";
import { isGoogleAuthEnabled } from "@/auth";
import { isSelfRegistrationAllowed } from "@/lib/self-registration";

export async function GET() {
  // selfRegistration: 招待なしの登録を受け付けるか（ログイン画面の「新規登録」・登録画面の案内に使う）
  return NextResponse.json({ google: isGoogleAuthEnabled, selfRegistration: isSelfRegistrationAllowed() });
}
