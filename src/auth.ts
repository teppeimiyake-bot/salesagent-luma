/**
 * NextAuth v5 設定（Auth.js）
 *
 * - プロバイダ: Google OAuth（招待制）
 * - セッション戦略: jwt（既存の自前JWTセッションと並存させるためシンプル化。
 *   PrismaAdapter を入れるとDBセッション戦略になりうるが、Edge互換と既存middleware互換のため jwt を採用）
 * - 招待制ロジック:
 *     - 既存ユーザーのemailと一致 → そのUserと紐付け
 *     - Inviteのemailと一致（未使用・未期限切れ） → そのInviteを使用してUser作成
 *     - どちらでもない → ログイン拒否（/login?error=AccessDenied）
 *
 * 環境変数:
 *   AUTH_SECRET / AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / NEXTAUTH_URL
 *
 * AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET が未設定の場合、Googleプロバイダは無効化される（UIではボタンを非表示）。
 */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// NextAuth は Edge 互換が必要だが、 Prisma + pg は Node 限定 → middleware では NextAuth を使わず
// 既存の jwtVerify 路線を維持。NextAuth はサインイン/コールバックとセッション読み出しのみで使う。

const globalForPool = globalThis as unknown as { authPool?: Pool };
const globalForPrisma = globalThis as unknown as { authPrisma?: PrismaClient };

const pool =
  globalForPool.authPool ??
  new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForPool.authPool = pool;

const prisma =
  globalForPrisma.authPrisma ??
  new PrismaClient({ adapter: new PrismaPg(pool) });
if (process.env.NODE_ENV !== "production") globalForPrisma.authPrisma = prisma;

const googleEnabled = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

export const isGoogleAuthEnabled = googleEnabled;

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? process.env.JWT_SECRET,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: googleEnabled
    ? [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID!,
          clientSecret: process.env.AUTH_GOOGLE_SECRET!,
          allowDangerousEmailAccountLinking: true,
        }),
      ]
    : [],
  callbacks: {
    /**
     * 招待制：許可されたメールアドレスのみログイン許可。
     * - 既存User.email一致 → permission/role はそのUserの値を使う
     * - 未使用Invite.email一致 → 新規User作成（permission/role はInviteの値）
     * - どちらでもない → 拒否
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return false;
      const email = (user.email ?? profile?.email)?.toLowerCase().trim();
      if (!email) return false;

      // 1) 既存User
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        // 画像 / emailVerified を補完
        if (user.image && !existing.image) {
          await prisma.user.update({
            where: { id: existing.id },
            data: { image: user.image, emailVerified: new Date() },
          });
        }
        return true;
      }

      // 2) Invite
      const invite = await prisma.invite.findFirst({
        where: {
          email,
          used: false,
          expiresAt: { gt: new Date() },
        },
      });
      if (invite) {
        const created = await prisma.user.create({
          data: {
            email,
            name: invite.name ?? user.name ?? email.split("@")[0],
            image: user.image ?? null,
            emailVerified: new Date(),
            role: invite.role,
            permission: invite.permission,
            // パスワード未設定（Googleログインのみ）
            passwordHash: null,
          },
        });
        await prisma.invite.update({
          where: { id: invite.id },
          data: { used: true, usedAt: new Date() },
        });
        // サインイン後の jwt callback で User.id を解決できるように、
        // user オブジェクトを書き換え
        (user as { id?: string }).id = created.id;
        return true;
      }

      // 3) 拒否
      return false;
    },
    async jwt({ token, user }) {
      // 初回サインイン時のみ user が入る
      if (user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email.toLowerCase().trim() },
          select: { id: true, email: true, name: true, permission: true, image: true },
        });
        if (dbUser) {
          token.userId = dbUser.id;
          token.email = dbUser.email;
          token.name = dbUser.name;
          token.permission = dbUser.permission;
          token.picture = dbUser.image ?? token.picture;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.userId) {
        (session.user as { id?: string }).id = token.userId as string;
      }
      if (token?.permission) {
        (session.user as { permission?: string }).permission = token.permission as string;
      }
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      // ログイン時に既存JWTのセッションCookieもセットして両系列で読めるようにする
      if (!user?.email) return;
      const dbUser = await prisma.user.findUnique({
        where: { email: user.email.toLowerCase().trim() },
        select: { id: true, email: true },
      });
      if (!dbUser) return;
      try {
        const { setSessionCookie, createSessionToken } = await import("@/lib/auth");
        const token = await createSessionToken({ userId: dbUser.id, email: dbUser.email });
        await setSessionCookie(token);
      } catch (e) {
        console.warn("[auth] failed to bridge JWT cookie", e);
      }
    },
  },
});
