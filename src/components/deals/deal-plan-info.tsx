"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Film, ExternalLink, FileText } from "lucide-react";

/**
 * Phase 1: Notion由来の「企画内容」(planContents) と「ご提案企画書」(proposalDocUrl) を
 * 商談詳細に閲覧表示するだけのコンポーネント。
 *
 * - データソース: deals.bant JSON
 *   - bant.planContents: string[]（13選択肢のタグ）
 *   - bant.proposalDocUrl: string（Canva URL等）
 * - データが何も無ければカード自体を描画しない（商談詳細を散らかさない）
 * - 編集UI / Notion同期 / DealProduct への反映は Phase 2 で実装
 */

// Notionの multi_select 色を踏襲した、カテゴリ別のピル色設定
// 完全一致でなく prefix 判定（新タグ追加にも一定耐性）
function tagColorClass(tag: string): string {
  if (tag.startsWith("【採用】")) return "bg-rose-100 text-rose-700 border-rose-200";
  if (tag.startsWith("【SNS】")) return "bg-sky-100 text-sky-700 border-sky-200";
  if (tag.startsWith("【会社紹介】"))
    return "bg-orange-100 text-orange-700 border-orange-200";
  if (tag.startsWith("【サービス紹介】"))
    return "bg-zinc-100 text-zinc-700 border-zinc-200";
  if (tag.startsWith("【CATV】")) return "bg-indigo-100 text-indigo-700 border-indigo-200";
  if (tag.startsWith("IR")) return "bg-pink-100 text-pink-700 border-pink-200";
  return "bg-zinc-100 text-zinc-700 border-zinc-200";
}

export function DealPlanInfo({ bant }: { bant: unknown }) {
  // 安全な narrow（bant は JSON 型）
  const b =
    bant && typeof bant === "object" && !Array.isArray(bant)
      ? (bant as Record<string, unknown>)
      : null;

  const planContents: string[] = Array.isArray(b?.planContents)
    ? (b!.planContents as unknown[]).filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : [];

  const proposalDocUrl: string | null =
    b && typeof b.proposalDocUrl === "string" && b.proposalDocUrl.length > 0
      ? b.proposalDocUrl
      : null;

  // 安全なURLか（http/https のみ許可。それ以外は新タブで開かない）
  const isSafeUrl =
    !!proposalDocUrl &&
    (proposalDocUrl.startsWith("https://") || proposalDocUrl.startsWith("http://"));

  // データが何も無ければ何も描画しない
  if (planContents.length === 0 && !proposalDocUrl) {
    return null;
  }

  return (
    <Card className="border-orange-200 bg-gradient-to-br from-orange-50/30 via-white to-amber-50/20 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
            <Film className="h-4 w-4" />
          </div>
          企画内容 ／ ご提案企画書
          <Badge variant="info" className="text-[10px]">
            Notion由来
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 企画内容（タグ） */}
        <div>
          <p className="text-xs font-semibold text-zinc-600 mb-2">企画内容</p>
          {planContents.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {planContents.map((tag) => (
                <span
                  key={tag}
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${tagColorClass(tag)}`}
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-400 italic">未設定</p>
          )}
        </div>

        {/* ご提案企画書URL */}
        <div>
          <p className="text-xs font-semibold text-zinc-600 mb-2">ご提案企画書</p>
          {isSafeUrl ? (
            <a
              href={proposalDocUrl!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 max-w-full rounded-md border border-emerald-200 bg-white px-2.5 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50 hover:border-emerald-300 transition-colors"
              title={proposalDocUrl!}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{proposalDocUrl}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </a>
          ) : proposalDocUrl ? (
            // URLとして安全でないものはリンク化せずテキストのみ表示
            <p className="text-xs text-zinc-500 break-all">{proposalDocUrl}</p>
          ) : (
            <p className="text-xs text-zinc-400 italic">未添付</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
