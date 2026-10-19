import { fetchQuoteLogo, LOGO_ISSUE_TIMEOUT_MS } from "@/lib/quote-logo";
import { isAcceptableLogoUrl } from "@/lib/quote-issuer";

/**
 * T14: 見積書PDFに描くロゴを用意する（発行・プレビューの直前に呼ぶ）。
 *
 * PDF には取得済みの PNG/JPEG の data URL だけを渡し、react-pdf に URL を取りに行かせない
 * （react-pdf は取得の失敗を黙って省き、時間の上限も無いため）。https の URL は短い上限時間で取得し、
 * 取れなければロゴなしで描いて、その旨の案内（warning）を返す。発行者設定・issuerSnapshot の値は変えない。
 */
export async function logoForPdf(
  logoUrl: string | null | undefined,
  mode: "issue" | "preview" = "issue",
): Promise<{ src: string | null; warning: string | null }> {
  const value = logoUrl?.trim();
  if (!value) return { src: null, warning: null };
  const lead = mode === "issue"
    ? "ロゴを取得できなかったため、ロゴなしで発行しました"
    : "ロゴを取得できなかったため、ロゴなしで表示しています";
  const tail = "管理画面の「見積書の発行者設定」でロゴを確認してください。";
  if (value.startsWith("data:")) {
    return isAcceptableLogoUrl(value)
      ? { src: value, warning: null }
      : { src: null, warning: `${lead}（設定されているロゴが PNG/JPEG の画像ではありません）。${tail}` };
  }
  const fetched = await fetchQuoteLogo(value, { timeoutMs: LOGO_ISSUE_TIMEOUT_MS });
  if (fetched.ok) return { src: fetched.dataUrl, warning: null };
  return { src: null, warning: `${lead}（${fetched.reason}）。${tail}` };
}
