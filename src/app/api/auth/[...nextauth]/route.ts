/**
 * NextAuth v5 ルートハンドラ
 *
 * このファイルが受け持つパス：
 *   /api/auth/signin            （NextAuth標準のサインインページ → 実体は /login にリダイレクト）
 *   /api/auth/signin/google     （Google OAuth開始）
 *   /api/auth/callback/google   （Google OAuthコールバック）
 *   /api/auth/session           （NextAuth セッション取得）
 *   /api/auth/csrf              （CSRFトークン）
 *   /api/auth/providers         （有効プロバイダ一覧）
 *   /api/auth/error             （エラー）
 *
 * 既存の /api/auth/login /api/auth/logout /api/auth/register /api/auth/avatar /api/auth/password
 * とパス衝突しないよう、NextAuthは [...nextauth] catch-all で受ける。
 * Next.jsのルーティング規則上、固定セグメント（login, logout 等）が catch-all より優先される。
 */
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
