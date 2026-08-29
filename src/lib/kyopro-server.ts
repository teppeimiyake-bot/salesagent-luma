/**
 * 京プロ機能のサーバー側ガードと初期化
 * ============================================================
 * 京プロ 撮影会派遣はリージーの事業なので、Luma タブ・全社ビューからは
 * 画面もAPIも触らせない。テナント境界そのものは src/lib/db.ts の Prisma Extension が
 * 担保しているが、ここでは「そもそもこの会社の機能ではない」を先に弾く。
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission, type Permission } from "@/lib/auth";
import { getRequestTenant, type TenantCtx } from "@/lib/tenant-context";
import { DEFAULT_RATES, KYOPRO_ROLES } from "@/lib/kyopro";

export const KYOPRO_TENANT_CODE = "reagey";

/** レート・設定の初期値を作った基準日（この日以前の撮影会にも適用される） */
const RATE_EPOCH = new Date(Date.UTC(2026, 0, 1));

export type KyoproGuard =
  | { ok: true; ctx: TenantCtx; permission: Permission }
  | { ok: false; response: NextResponse };

/**
 * API Route 用。リージーで、かつ必要権限を満たしているかを確認する。
 *   const g = await guardKyopro("user");
 *   if (!g.ok) return g.response;
 */
export async function guardKyopro(level: Permission = "user"): Promise<KyoproGuard> {
  const ctx = await getRequestTenant();
  if (!ctx) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (ctx.code !== KYOPRO_TENANT_CODE) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "京プロは株式会社リージーの機能です。会社タブをリージーに切り替えてください。" },
        { status: 403 },
      ),
    };
  }
  const permission = await getCurrentPermission();
  if (!hasPermission(permission, level)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, ctx, permission: permission as Permission };
}

/** 画面側の判定（リージーを見ているか） */
export async function isKyoproTenant(): Promise<boolean> {
  const ctx = await getRequestTenant();
  return ctx?.code === KYOPRO_TENANT_CODE;
}

/**
 * 職種レートと設定の初回作成。
 * 4職種そろっていなければ不足分だけ足すので、レート改定後に呼ばれても既存行は壊さない。
 */
export async function ensureKyoproRates() {
  const existing = await prisma.kyoproRate.findMany();
  const missing = KYOPRO_ROLES.filter((r) => !existing.some((e) => e.role === r));
  if (missing.length > 0) {
    await prisma.kyoproRate.createMany({
      data: missing.map((role) => ({
        role,
        billRate: DEFAULT_RATES[role].billRate,
        payRateDefault: DEFAULT_RATES[role].payRateDefault,
        payRateTrainee: DEFAULT_RATES[role].payRateTrainee ?? null,
        effectiveFrom: RATE_EPOCH,
      })),
    });
  }
  const setting = await prisma.kyoproSetting.findFirst();
  if (!setting) await prisma.kyoproSetting.create({ data: {} });

  const [rates, settings] = await Promise.all([
    prisma.kyoproRate.findMany({ orderBy: [{ role: "asc" }, { effectiveFrom: "asc" }] }),
    prisma.kyoproSetting.findFirst(),
  ]);
  return { rates, setting: settings! };
}
