/**
 * Notion 双方向同期ヘルパー（Lumaヨミ表 → Notion）
 *
 * 用途:
 *   サイト側で `deals.appointmentDate` を更新したとき、
 *   対応する Notion ページの「商談日」プロパティを更新する。
 *
 * 設計方針:
 *   - 失敗してもサイト本体の処理は止めない（throw せず { ok: false, reason } を返す）
 *   - APIキー本体は絶対にログ出力しない
 *   - Notion 側のプロパティ名は **「商談日」** （日本語固定。社長判断 Q-A B案）
 *   - Notion API バージョン: "2025-09-03"（前回 import-luma-yomi.ts で WRITE 成功した版）
 *
 * 制約:
 *   - bant.notionPageId が無い deal は no-op（成功扱いで `{ ok: true, skipped: true }`）
 *   - NOTION_API_KEY 未設定なら no-op（同上）
 *   - Notion 側で「商談日」プロパティが存在しない／型がdate以外、はNotionが400を返すので失敗扱い
 */

import { prisma } from "@/lib/db";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2025-09-03";
const NOTION_DATE_PROPERTY = "商談日";

export type NotionSyncResult =
  | { ok: true; skipped?: boolean; reason?: string }
  | { ok: false; reason: string };

/**
 * Deal の appointmentDate を Notion ページの「商談日」プロパティに反映する。
 *
 * @param dealId  Luma DB の deals.id (uuid)
 * @param date    新しい商談日。null なら Notion 側もクリア。Date or YYYY-MM-DD 文字列。
 * @returns       { ok: true } で成功、{ ok: false, reason } で失敗（サイト本体は止めない）
 */
export async function syncDealAppointmentDateToNotion(
  dealId: string,
  date: Date | string | null,
): Promise<NotionSyncResult> {
  if (!NOTION_API_KEY) {
    // 開発環境などでAPIキー未設定の場合は no-op で成功扱い（呼び出し元の処理を止めない）
    return { ok: true, skipped: true, reason: "NOTION_API_KEY not set" };
  }

  // bant.notionPageId を取得
  let notionPageId: string | null = null;
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { bant: true },
    });
    const b = deal?.bant as Record<string, unknown> | null;
    if (b && typeof b === "object" && typeof b.notionPageId === "string") {
      notionPageId = b.notionPageId;
    }
  } catch (e) {
    return { ok: false, reason: `db-lookup-failed: ${(e as Error).message}` };
  }

  if (!notionPageId) {
    // Notion由来でないdealは同期対象外（成功扱い）
    return { ok: true, skipped: true, reason: "no-notionPageId" };
  }

  // 日付フォーマット (YYYY-MM-DD)
  let datePayload: { date: { start: string } | null };
  if (date == null) {
    datePayload = { date: null };
  } else {
    const d = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) {
      return { ok: false, reason: `invalid-date: ${String(date)}` };
    }
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    datePayload = { date: { start: ymd } };
  }

  // Notion PATCH
  const url = `https://api.notion.com/v1/pages/${notionPageId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          [NOTION_DATE_PROPERTY]: datePayload,
        },
      }),
    });
  } catch (e) {
    // ネットワーク等の例外（APIキーは絶対に出さない）
    console.error("[notion-sync] fetch error", {
      dealId,
      notionPageId,
      error: (e as Error).message,
    });
    return { ok: false, reason: `network-error: ${(e as Error).message}` };
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch {
      errBody = "<read-failed>";
    }
    // APIキー本体は絶対に出さない（errBody は Notion 側のメッセージなので含まれない想定だが、
    // 念のため Bearer トークン文字列が含まれないかも目視確認しやすく出す）
    console.error("[notion-sync] PATCH failed", {
      dealId,
      notionPageId,
      status: res.status,
      statusText: res.statusText,
      body: errBody.slice(0, 1000),
    });
    return { ok: false, reason: `notion-api-${res.status}` };
  }

  return { ok: true };
}
