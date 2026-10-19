import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QuoteSettingsForm } from "@/components/admin/quote-settings-form";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { loadQuoteIssuerSettings } from "@/lib/quote-issuer-server";

export const dynamic = "force-dynamic";

/**
 * T14: 見積書の発行者設定（管理者のみ）
 *
 * これまで発行者（社名・住所・ロゴ・採番・標準備考）は PATCH /api/admin/quote-settings を
 * 直接呼ぶしかなかった。ここから編集できるようにする。見積作成画面のプレビューと、
 * 標準備考（既定ON）・交通費備考（選択式）の文面はこの設定を読む。
 * FEATURE_QUOTE_PDF_V2 がOFFのときは見積テンプレート画面と同じく「未有効」の案内だけ出す。
 */
export default async function AdminQuoteSettingsPage() {
  const session = await getSession();
  const me = session ? { permission: await getCurrentPermission() } : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  if (!isQuotePdfV2Enabled()) {
    return (
      <>
        <Header title="見積書の発行者設定" subtitle="管理者のみ" />
        <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
          <Card className="border-zinc-200">
            <CardContent className="p-8">
              <p className="text-[15px] font-semibold text-zinc-900">この機能は未有効です</p>
              <p className="mt-2 text-sm text-zinc-600 leading-relaxed">
                発行者設定は見積書PDF v2（<code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">FEATURE_QUOTE_PDF_V2</code>）
                と一緒に動く機能です。環境変数を有効にすると、この画面から設定できるようになります。
              </p>
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  const [loaded, issuedCount] = await Promise.all([
    loadQuoteIssuerSettings(),
    prisma.quote.count({ where: { quoteNumber: { not: null } } }),
  ]);

  return (
    <>
      <Header title="見積書の発行者設定" subtitle="管理者のみ" />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card className="border-zinc-200">
          <CardContent className="p-6">
            <p className="text-[15px] text-zinc-600 mb-5 inline-flex items-center gap-2 flex-wrap">
              <Badge variant="danger">管理者専用</Badge>
              見積書PDFの右上に出る発行者、見積番号の採番、備考の文面を設定します。発行済みの見積書は変わりません。
            </p>
            {loaded ? (
              <QuoteSettingsForm initial={loaded.settings} saved={loaded.saved} hasIssuedNumbers={issuedCount > 0} />
            ) : (
              <p className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500">
                会社（Luma / リージー）を切り替えてから開いてください。全社統合ビューでは設定できません。
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
