/**
 * 発行者設定（QuoteIssuerProfile）を画面用に読むサーバー専用ヘルパー。
 * 見積作成画面の既定値API（/api/admin/quote-settings/defaults）と管理画面（/admin/quote-settings）で共通。
 */
import { prisma } from "@/lib/db";
import { getRequestTenant } from "@/lib/tenant-context";
import { defaultIssuerProfileData } from "@/lib/quote-issuer";

export type QuoteIssuerSettings = ReturnType<typeof defaultIssuerProfileData>;

/**
 * 発行者設定を読み書きするテナント（操作中の会社）。全社統合ビュー（crossTenant）や、テナントが
 * 決まらないときは null。全社統合ビューでは Prisma の tenant 条件が付かないため、そのまま
 * findFirst() すると別の会社の設定行を読んでしまう（書き込みは例外になる）。
 */
export async function quoteSettingsTenantId(): Promise<string | null> {
  const ctx = await getRequestTenant();
  if (!ctx || ctx.crossTenant || !ctx.tenantId) return null;
  return ctx.tenantId;
}

/**
 * 操作中のテナントの発行者設定。保存済みの行が無ければ、初回発行時に作られるのと同じ既定値を
 * saved=false で返す（GET の途中で行を作らない）。全社統合ビューなどテナントが決まらないときは null
 * （別の会社の行を読まないよう、DB は見ない）。
 */
export async function loadQuoteIssuerSettings(): Promise<{ settings: QuoteIssuerSettings; saved: boolean } | null> {
  const tenantId = await quoteSettingsTenantId();
  if (!tenantId) return null;
  const profile = await prisma.quoteIssuerProfile.findFirst({ where: { tenantId } });
  if (profile) {
    return {
      saved: true,
      settings: {
        legalName: profile.legalName,
        postalCode: profile.postalCode,
        addressLine1: profile.addressLine1,
        addressLine2: profile.addressLine2,
        logoUrl: profile.logoUrl,
        defaultNotes: profile.defaultNotes,
        travelExpenseNote: profile.travelExpenseNote,
        numberPrefix: profile.numberPrefix,
        nextQuoteNumber: profile.nextQuoteNumber,
      },
    };
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, code: true } });
  return tenant ? { settings: defaultIssuerProfileData(tenant), saved: false } : null;
}
