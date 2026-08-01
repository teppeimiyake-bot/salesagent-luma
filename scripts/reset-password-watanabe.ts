/**
 * 渡邊さん (luma.official2022@gmail.com) のパスワード再発行（使い捨て）
 *
 * 背景:
 *   旧パスワードは bcrypt ハッシュ保存のため復号不可。ログイン不可の報告を受け再発行で対応。
 *
 * 使い方（本番 Neon DB に対して）:
 *   # DRY-RUN（既定）— 対象検出 + 新パスワード生成 + bcrypt化までで UPDATE はしない
 *   npx tsx --env-file=.env.production.local scripts/reset-password-watanabe.ts
 *   # 本実行
 *   npx tsx --env-file=.env.production.local scripts/reset-password-watanabe.ts --apply
 *
 * 設計（reset-password-katamoto.ts と同一）:
 * - 対象 email は定数固定。CLI 引数では指定不可。
 * - WHERE id（email で二重ガード）の単一 UPDATE のみ。他レコードには触れない。
 * - --apply 後は bcrypt.compare で検証。平文は stdout に1回だけ表示。永続化しない。
 */
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const TARGET_EMAIL = "luma.official2022@gmail.com";

function generatePassword(len = 16): string {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*";
  const buf = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += charset[buf[i]! % charset.length];
  return out;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:****@${u.hostname}${u.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("[ERR] DATABASE_URL is not set"); process.exit(1); }

  console.log("================================================================");
  console.log("Reset Password (Single User, One-shot) — 渡邊さん");
  console.log("================================================================");
  console.log(`Mode         : ${apply ? "APPLY (will UPDATE)" : "DRY-RUN (no write)"}`);
  console.log(`DATABASE_URL : ${maskUrl(dbUrl)}`);
  console.log(`Target email : ${TARGET_EMAIL}`);
  console.log("----------------------------------------------------------------");

  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: ["error", "warn"] });

  try {
    const user = await prisma.user.findUnique({
      where: { email: TARGET_EMAIL },
      select: { id: true, email: true, name: true, permission: true, role: true },
    });
    if (!user) { console.error(`[ABORT] User not found: ${TARGET_EMAIL}`); process.exit(2); }

    console.log("Found user:");
    console.log(`  id         : ${user.id}`);
    console.log(`  email      : ${user.email}`);
    console.log(`  name       : ${user.name}`);
    console.log(`  permission : ${user.permission}`);
    console.log(`  role       : ${user.role}`);

    const newPassword = generatePassword(16);
    const newHash = await bcrypt.hash(newPassword, 10);
    console.log("----------------------------------------------------------------");
    console.log(`Generated new password (length=${newPassword.length}): OK`);

    if (!apply) {
      console.log("----------------------------------------------------------------");
      console.log("[DRY-RUN] No UPDATE issued. Re-run with --apply to commit.");
      console.log("================================================================");
      return;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
      select: { id: true, email: true, passwordHash: true },
    });

    const verifyOk = await bcrypt.compare(newPassword, updated.passwordHash ?? "");
    console.log("----------------------------------------------------------------");
    console.log(`[OK] Password updated for ${updated.email}`);
    console.log(`     bcrypt.compare(newPassword, storedHash) = ${verifyOk}`);
    if (!verifyOk) { console.error("[ERR] Verification failed after update."); process.exit(3); }

    console.log("================================================================");
    console.log("NEW PLAINTEXT PASSWORD (copy now, will not be shown again):");
    console.log("----------------------------------------------------------------");
    console.log(`  email    : ${updated.email}`);
    console.log(`  password : ${newPassword}`);
    console.log("================================================================");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => { console.error("[FATAL]", err); process.exit(99); });
