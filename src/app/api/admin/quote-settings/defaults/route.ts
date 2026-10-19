import { NextResponse } from "next/server";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { loadQuoteIssuerSettings } from "@/lib/quote-issuer-server";
import { quoteNotePresets } from "@/lib/quote-notes";
import { writeForbidden } from "@/lib/write-guard";

/**
 * GET /api/admin/quote-settings/defaults — 見積作成画面が使う発行者の表示と備考プリセット（T14）。
 *
 * 設定の変更（PATCH /api/admin/quote-settings）は管理者だけだが、見積を作る営業（user 以上）も
 * 画面内プレビューの発行者と、標準備考（既定ON）・交通費備考（選択式）の文面を読む必要がある。
 * そのため読み取り専用で、画面に要る項目だけを返す（採番の現在値などは返さない）。
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) return await writeForbidden();
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const loaded = await loadQuoteIssuerSettings();
  const settings = loaded?.settings ?? null;
  return NextResponse.json({
    issuer: settings
      ? {
          legalName: settings.legalName,
          postalCode: settings.postalCode,
          addressLine1: settings.addressLine1,
          addressLine2: settings.addressLine2,
          logoUrl: settings.logoUrl,
        }
      : null,
    notes: quoteNotePresets(settings),
    canManage: perm === "admin",
  });
}
