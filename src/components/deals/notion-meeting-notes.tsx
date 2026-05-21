"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollText, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

/**
 * Phase 1: Notion ヨミ表ページの「★初回商談ヒアリングシート」セクションを取り込んだ
 * 議事録テキストを商談詳細に閲覧表示するだけのコンポーネント。
 *
 * - データソース: deals.bant JSON
 *   - bant.meetingNotes                  : string（議事録本文・Markdown風）
 *   - bant.meetingNotesSection           : string（採用したセクション見出し）
 *   - bant.meetingNotesSource            : "notion"
 *   - bant.meetingNotesUpdatedAt         : ISO 文字列（取込時刻）
 *   - bant.meetingNotesNotionLastEditedAt: ISO 文字列（Notion 側の最終更新）
 *   - bant.notionPageUrl                 : Notion ページ URL（既存）
 * - データが無ければカード自体を描画しない（DealPlanInfo と同じ流儀）
 * - 編集UIなし。再取込は scripts/import-notion-meeting-notes.ts --apply で実施。
 */

type NotionMeetingNotesProps = {
  bant: unknown;
};

const PREVIEW_THRESHOLD = 600; // 600字を超えたら折り畳む

export function NotionMeetingNotes({ bant }: NotionMeetingNotesProps) {
  const [expanded, setExpanded] = useState(false);

  // 安全な narrow（bant は JSON 型）
  const b =
    bant && typeof bant === "object" && !Array.isArray(bant)
      ? (bant as Record<string, unknown>)
      : null;

  const meetingNotes =
    b && typeof b.meetingNotes === "string" && b.meetingNotes.length > 0
      ? b.meetingNotes
      : null;

  if (!meetingNotes) {
    return null;
  }

  const section =
    b && typeof b.meetingNotesSection === "string" && b.meetingNotesSection.length > 0
      ? b.meetingNotesSection
      : null;

  const source =
    b && typeof b.meetingNotesSource === "string" ? b.meetingNotesSource : null;

  const notionLastEditedAt =
    b && typeof b.meetingNotesNotionLastEditedAt === "string"
      ? b.meetingNotesNotionLastEditedAt
      : null;

  const notionUrl =
    b && typeof b.notionPageUrl === "string" && b.notionPageUrl.length > 0
      ? b.notionPageUrl
      : null;

  // 安全なURLか（http/https のみ）
  const isSafeNotionUrl =
    !!notionUrl && (notionUrl.startsWith("https://") || notionUrl.startsWith("http://"));

  // 折り畳み判定
  const isLong = meetingNotes.length > PREVIEW_THRESHOLD;
  const displayed = isLong && !expanded ? meetingNotes.slice(0, PREVIEW_THRESHOLD) : meetingNotes;

  // 日付の整形（YYYY/MM/DD のみ。失敗したら raw を返す）
  const lastEditedLabel = (() => {
    if (!notionLastEditedAt) return null;
    const d = new Date(notionLastEditedAt);
    if (Number.isNaN(d.getTime())) return notionLastEditedAt;
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  })();

  return (
    <Card className="border-violet-200 bg-gradient-to-br from-violet-50/30 via-white to-fuchsia-50/20 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <div className="rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white p-1.5 shadow-sm">
            <ScrollText className="h-4 w-4" />
          </div>
          初回商談ヒアリングシート
          {source === "notion" && (
            <Badge variant="info" className="text-[10px]">
              Notion由来
            </Badge>
          )}
          {section && (
            <span className="text-[11px] text-zinc-500 font-normal">
              section: {section}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 議事録本文 */}
        <div className="rounded-md border border-zinc-200 bg-white">
          <pre className="text-xs leading-relaxed text-zinc-800 px-3 py-2.5 whitespace-pre-wrap font-sans break-words max-h-[600px] overflow-y-auto">
            {displayed}
            {isLong && !expanded && "..."}
          </pre>
        </div>

        {/* メタ情報 + 折りたたみトグル */}
        <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-zinc-500">
          <div className="flex items-center gap-2 flex-wrap">
            <span>{meetingNotes.length}字</span>
            {lastEditedLabel && (
              <>
                <span className="text-zinc-300">|</span>
                <span>Notion更新: {lastEditedLabel}</span>
              </>
            )}
            {isSafeNotionUrl && (
              <>
                <span className="text-zinc-300">|</span>
                <a
                  href={notionUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-violet-600 hover:text-violet-700 hover:underline"
                >
                  Notionで開く
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </div>
          {isLong && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              className="text-violet-600 hover:text-violet-700 hover:bg-violet-50 h-7 px-2"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3 mr-1" />
                  折りたたむ
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3 mr-1" />
                  全文表示（残り{meetingNotes.length - PREVIEW_THRESHOLD}字）
                </>
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
