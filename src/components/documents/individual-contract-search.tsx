"use client";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  FileSignature,
  Download,
  ExternalLink,
  Link2,
  Building2,
  Factory,
  X,
  Check,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { matchesIndustry, parseIndustries } from "@/lib/industry";

/** 個別契約書（= 受注商談ごとの契約書ドキュメント）の1件分 */
export type IndividualContract = {
  id: string;
  name: string;
  description: string | null;
  fileUrl: string;
  sourceType: string;
  version: string | null;
  createdAt: string;
  uploadedByName: string | null;
  dealId: string;
  dealTitle: string;
  companyName: string;
  industry: string | null;
};

export function IndividualContractSearch({
  contracts,
  industries,
}: {
  contracts: IndividualContract[];
  /** 業界フィルターの選択肢（実データに存在する業界のみ） */
  industries: string[];
}) {
  // 業界は複数選択（配列）。同一カテゴリ内は OR。
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");

  // 企画書タブ（individual-proposal-search.tsx）と同じトグル方式：
  // 選択済みなら外す、未選択なら足す。
  function toggleIndustry(v: string) {
    setSelectedIndustries((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  }

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return contracts.filter((c) => {
      // 業界条件：選択中の業界のうち「いずれか」に一致すればヒット（OR）。
      // industry は「,」区切りで複数業界を持ちうるので matchesIndustry で判定。
      if (
        selectedIndustries.length > 0 &&
        !selectedIndustries.some((ind) => matchesIndustry(c.industry, ind))
      )
        return false;
      // 社名キーワード：業界条件とは AND。
      if (kw) {
        const hay = `${c.companyName} ${c.dealTitle} ${c.name}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [contracts, selectedIndustries, keyword]);

  const hasFilter = selectedIndustries.length > 0 || keyword.trim() !== "";

  function clearAll() {
    setSelectedIndustries([]);
    setKeyword("");
  }

  return (
    <div className="space-y-4">
      {/* 検索・フィルターパネル */}
      <Card className="border-red-200 bg-gradient-to-br from-red-50/50 via-white to-rose-50/30 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <div className="rounded-lg bg-gradient-to-br from-red-500 to-rose-500 text-white p-1.5 shadow-sm">
              <Search className="h-4 w-4" />
            </div>
            個別契約書を検索
            <Badge variant="secondary" className="ml-1">
              {filtered.length} / {contracts.length} 件
            </Badge>
            {hasFilter && (
              <button
                onClick={clearAll}
                className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800"
              >
                <X className="h-3.5 w-3.5" />
                条件をクリア
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 社名検索 */}
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="社名・商談名・契約書名で検索..."
              className="pl-9"
            />
          </div>

          {/* 業界フィルター（複数選択可・選択業界のいずれかに一致でヒット） */}
          <div>
            <p className="flex items-center gap-1 text-xs text-zinc-500 mb-1.5">
              <Factory className="h-3 w-3" /> 業界
              {selectedIndustries.length > 0 && (
                <span className="text-sky-600 font-medium">
                  （{selectedIndustries.length}件選択中・いずれかに一致）
                </span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip
                label="すべての業界"
                active={selectedIndustries.length === 0}
                onClick={() => setSelectedIndustries([])}
                activeClass="bg-sky-600 text-white border-sky-600"
              />
              {industries.map((v) => (
                <FilterChip
                  key={v}
                  label={v}
                  active={selectedIndustries.includes(v)}
                  onClick={() => toggleIndustry(v)}
                  activeClass="bg-sky-600 text-white border-sky-600"
                />
              ))}
              {industries.length === 0 && (
                <span className="text-xs text-zinc-400">登録された業界がありません</span>
              )}
            </div>
          </div>
          <p className="text-[11px] text-zinc-400">
            ※ 受注ステータスの商談に紐づく個別契約書のみを表示しています。
          </p>
        </CardContent>
      </Card>

      {/* 検索結果 */}
      {contracts.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-base text-zinc-500">
            まだ受注企業の個別契約書がありません。
            <br />
            <span className="text-xs">
              受注商談の詳細「この商談の個別契約書」から契約書を登録すると、ここで横断検索できます。
            </span>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-base text-zinc-500">
            条件に一致する個別契約書がありません。
            <br />
            <span className="text-xs">業界・社名の条件を変えてお試しください。</span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-zinc-100">
              {filtered.map((c) => (
                <ContractRow key={c.id} c={c} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  activeClass,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  activeClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
        active
          ? activeClass
          : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
      )}
    >
      {active && <Check className="h-3 w-3" />}
      {label}
    </button>
  );
}

function ContractRow({ c }: { c: IndividualContract }) {
  const isUrl = c.sourceType === "url";
  const hasFile = !!c.fileUrl && c.fileUrl !== "(リンク未登録)" && !c.fileUrl.includes(" ");
  return (
    <li className="px-5 py-3.5 flex items-start gap-3 hover:bg-zinc-50">
      <div className={cn("rounded-md p-2 shrink-0", isUrl ? "bg-sky-50" : "bg-red-50")}>
        {isUrl ? (
          <Link2 className="h-4 w-4 text-sky-600" />
        ) : (
          <FileSignature className="h-4 w-4 text-red-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">
          {c.name}
          {c.version && (
            <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">{c.version}</span>
          )}
          {isUrl && (
            <span className="ml-1.5 text-[10px] text-sky-600 font-normal">外部リンク</span>
          )}
        </p>
        <p className="flex flex-wrap items-center gap-1 text-xs text-zinc-600 mt-0.5">
          <Building2 className="h-3 w-3 shrink-0 text-zinc-400" />
          {/* 社名クリックでこの契約書が紐づく商談（Deal）詳細へ遷移 */}
          <a
            href={`/deals/${c.dealId}`}
            title={`${c.companyName} の商談「${c.dealTitle}」を開く`}
            className="font-medium text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-red-600 hover:decoration-red-400 transition-colors"
          >
            {c.companyName}
          </a>
          {parseIndustries(c.industry).map((ind) => (
            <Badge key={ind} variant="info" className="text-[10px]">
              {ind}
            </Badge>
          ))}
        </p>
        <p className="text-[10px] text-zinc-400 mt-1 truncate">
          商談: {c.dealTitle} ／ {c.uploadedByName ?? "—"} ／ {formatDate(c.createdAt)}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {isUrl ? (
          <a
            href={c.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-600 hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="h-3.5 w-3.5" /> 開く
          </a>
        ) : hasFile ? (
          <a
            href={`/api/documents/${c.id}/download`}
            className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"
          >
            <Download className="h-3.5 w-3.5" /> ダウンロード
          </a>
        ) : (
          <span className="text-xs text-zinc-400">未アップロード</span>
        )}
        <a
          href={`/deals/${c.dealId}`}
          className="text-[11px] text-zinc-500 hover:text-red-600 hover:underline"
        >
          商談を開く →
        </a>
      </div>
    </li>
  );
}
