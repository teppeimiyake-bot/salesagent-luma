import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission } from "@/lib/auth";
import { ensureQuoteIssuerProfile, isAcceptableLogoUrl } from "@/lib/quote-issuer";
import { quoteSettingsTenantId } from "@/lib/quote-issuer-server";
import { fetchQuoteLogo, LOGO_SAVE_TIMEOUT_MS } from "@/lib/quote-logo";

/**
 * GET/PATCH /api/admin/quote-settings — 見積書の発行者設定（管理者のみ）。
 * 画面は /admin/quote-settings。見積作成画面が読む既定値は ./defaults（user 以上・読み取り専用）。
 *
 * nextQuoteNumber（次に使う連番＝開始番号）は、送られたときだけ変える。発行済みの番号がある
 * テナントでは下げられない（同じ日付で番号が重なり、発行が「採番に失敗しました」になるため）。
 * 確認から書き込みまでの間に発行で番号が進んだときは、古い値で上書きせず 409 を返す。
 *
 * 設定は会社ごと。全社統合ビュー（Luma＋リージー）では読み書きしない（409 で会社の切り替えを案内する）。
 *
 * ロゴが https の URL のときは、保存の前にサーバーから取得できるか確かめる（src/lib/quote-logo.ts：
 * 5秒・PNG/JPEG・約290KBまで・内部アドレスやリダイレクトの行き先も確認）。新しく入れた URL が取れなければ
 * 400 で理由を返して保存しない。保存済みと同じ URL が取れなくなっていたときは、ほかの項目の保存を妨げない
 * よう保存し、logoWarning で「このままではロゴなしで発行される」ことを返す。
 */
const SWITCH_TENANT_MESSAGE = "会社（Luma / リージー）を切り替えてから操作してください。全社統合ビューでは発行者設定を扱えません";

const schema = z.object({
  legalName: z.string().min(1), postalCode: z.string().min(1), addressLine1: z.string().min(1),
  addressLine2: z.string().min(1),
  logoUrl: z.string().refine(isAcceptableLogoUrl, "ロゴは https のURLか PNG/JPEG の画像（約290KBまで）にしてください").nullable().optional(),
  defaultNotes: z.string(),
  travelExpenseNote: z.string().nullable().optional(), numberPrefix: z.string().min(1).max(12).regex(/^[A-Za-z0-9_-]+$/),
  nextQuoteNumber: z.number().int().min(1).max(999_999).optional(),
});

export async function GET() {
  if (await getCurrentPermission() !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const tenantId = await quoteSettingsTenantId();
  if (!tenantId) return NextResponse.json({ error: SWITCH_TENANT_MESSAGE }, { status: 409 });
  const profile = await prisma.quoteIssuerProfile.findFirst({ where: { tenantId } });
  if (!profile) return NextResponse.json({ error: "発行者設定がありません" }, { status: 404 });
  const templates = await prisma.quoteTemplate.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { lines: { orderBy: { sortOrder: "asc" } } } });
  return NextResponse.json({ profile, templates });
}

export async function PATCH(req: Request) {
  if (await getCurrentPermission() !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.flatten();
    return NextResponse.json({ error: detail.fieldErrors.logoUrl?.[0] ?? "Invalid input", detail }, { status: 400 });
  }
  const tenantId = await quoteSettingsTenantId();
  if (!tenantId) return NextResponse.json({ error: SWITCH_TENANT_MESSAGE }, { status: 409 });
  const profile = await ensureQuoteIssuerProfile(prisma, tenantId);
  const { nextQuoteNumber, ...fields } = parsed.data;
  // isAcceptableLogoUrl は new URL() で読むため「HTTPS://…」や前後に空白のある値も通る。data URL 以外は
  // 正規化した href を保存・判定に使い、https かどうかは protocol で見る（取得の確認を素通りさせない）。
  if (fields.logoUrl && !fields.logoUrl.startsWith("data:")) fields.logoUrl = new URL(fields.logoUrl.trim()).href;
  let logoWarning: string | undefined;
  if (fields.logoUrl && !fields.logoUrl.startsWith("data:") && new URL(fields.logoUrl).protocol === "https:") {
    const fetched = await fetchQuoteLogo(fields.logoUrl, { timeoutMs: LOGO_SAVE_TIMEOUT_MS });
    if (!fetched.ok) {
      const problem = `ロゴの画像を取得できませんでした（${fetched.reason}）。`;
      if (fields.logoUrl !== profile.logoUrl) {
        return NextResponse.json({
          error: `${problem}URL を確かめるか、「画像を選ぶ」で PNG/JPEG のファイルを設定してください`,
        }, { status: 400 });
      }
      logoWarning = `${problem}このままでは見積書はロゴなしで発行されます。URL を確かめるか、画像ファイルを設定してください`;
    }
  }
  if (nextQuoteNumber === undefined) {
    const updated = await prisma.quoteIssuerProfile.update({ where: { id: profile.id }, data: fields });
    return NextResponse.json({ profile: updated, logoWarning });
  }
  if (nextQuoteNumber < profile.nextQuoteNumber) {
    const issued = await prisma.quote.count({ where: { quoteNumber: { not: null } } });
    if (issued > 0) {
      return NextResponse.json({
        error: `発行済みの見積があるため、次の番号は現在の値（${profile.nextQuoteNumber}）より小さくできません`,
      }, { status: 409 });
    }
  }
  // 確認に使った値のままのときだけ書き換える（1つの UPDATE … WHERE next_quote_number = 確認した値）。
  // 確認から書き込みまでの間に見積が発行されて番号が進んでいたら、古い値で戻さずに 409 を返す。
  const { count } = await prisma.quoteIssuerProfile.updateMany({
    where: { id: profile.id, nextQuoteNumber: profile.nextQuoteNumber },
    data: { ...fields, nextQuoteNumber },
  });
  if (count === 0) {
    return NextResponse.json({
      error: "保存の途中で見積が発行され、次の番号が変わりました。画面を再読み込みしてから、もう一度保存してください",
    }, { status: 409 });
  }
  const updated = await prisma.quoteIssuerProfile.findFirst({ where: { id: profile.id } });
  return NextResponse.json({ profile: updated, logoWarning });
}
