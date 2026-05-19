"use client";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  FileText,
  Download,
  ExternalLink,
  Link2,
  Building2,
  Factory,
  Package,
  X,
  Check,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { matchesIndustry, parseIndustries } from "@/lib/industry";

/** 個別提案書（= 商談ごとの提案書ドキュメント）の1件分 */
export type IndividualProposal = {
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
  /** この商談に紐づくプロダクト（カテゴリ）名の一覧。例 ["映像", "SNS運用"] */
  products: string[];
  /** この商談の映像プランで選ばれた企画提案名の一覧。例 ["【採用】ドラマ風動画"] */
  planProposals: string[];
};

export function IndividualProposalSearch({
  proposals,
  industries,
  products,
}: {
  proposals: IndividualProposal[];
  /** 業界フィルターの選択肢（実データに存在する業界のみ） */
  industries: string[];
  /** プロダクト（企画提案）フィルターの選択肢 */
  products: string[];
}) {
  // 業界・プロダクトともに複数選択（配列）。同一カテゴリ内は OR、カテゴリ間は AND。
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");

  // ヨミフィルター（yomi-filter.tsx）と同じトグル方式：
  // 選択済みなら外す、未選択なら足す。
  function toggleIndustry(v: string) {
    setSelectedIndustries((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  }
  function toggleProduct(v: string) {
    setSelectedProducts((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  }

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return proposals.filter((p) => {
      // 業界条件：選択中の業界のうち「いずれか」に一致すればヒット（OR）。
      // industry は「,」区切りで複数業界を持ちうるので matchesIndustry で判定。
      if (
        selectedIndustries.length > 0 &&
        !selectedIndustries.some((ind) => matchesIndustry(p.industry, ind))
      )
        return false;
      // プロダクト条件：選択中のプロダクト/企画提案のうち「いずれか」に一致すればヒット（OR）。
      if (
        selectedProducts.length > 0 &&
        !selectedProducts.some(
          (prod) =>
            p.products.includes(prod) || p.planProposals.includes(prod),
        )
      )
        return false;
      // 社名キーワード：業界条件・プロダクト条件とは AND。
      if (kw) {
        const hay = `${p.companyName} ${p.dealTitle} ${p.name}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [proposals, selectedIndustries, selectedProducts, keyword]);

  const hasFilter =
    selectedIndustries.length > 0 ||
    selectedProducts.length > 0 ||
    keyword.trim() !== "";

  function clearAll() {
    setSelectedIndustries([]);
    setSelectedProducts([]);
    setKeyword("");
  }

  return (
    <div className="space-y-4">
      {/* 検索・フィルターパネル */}
      <Card className="border-orange-200 bg-gradient-to-br from-orange-50/50 via-white to-amber-50/30 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
              <Search className="h-4 w-4" />
            </div>
            個別提案書を検索
            <Badge variant="secondary" className="ml-1">
              {filtered.length} / {proposals.length} 件
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
              placeholder="社名・商談名・提案書名で検索..."
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

          {/* プロダクト（企画提案）フィルター（複数選択可） */}
          <div>
            <p className="flex items-center gap-1 text-xs text-zinc-500 mb-1.5">
              <Package className="h-3 w-3" /> プロダクト（企画提案）
              {selectedProducts.length > 0 && (
                <span className="text-orange-600 font-medium">
                  （{selectedProducts.length}件選択中・いずれかに一致）
                </span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip
                label="すべて"
                active={selectedProducts.length === 0}
                onClick={() => setSelectedProducts([])}
                activeClass="bg-orange-600 text-white border-orange-600"
              />
              {products.map((v) => (
                <FilterChip
                  key={v}
                  label={v}
                  active={selectedProducts.includes(v)}
                  onClick={() => toggleProduct(v)}
                  activeClass="bg-orange-600 text-white border-orange-600"
                />
              ))}
              {products.length === 0 && (
                <span className="text-xs text-zinc-400">
                  プロダクト・企画提案が未登録です
                </span>
              )}
            </div>
          </div>
          {(selectedIndustries.length > 0 && selectedProducts.length > 0) && (
            <p className="text-[11px] text-zinc-400">
              ※ 業界 と プロダクト の両条件を満たす提案書のみ表示しています（AND）。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 検索結果 */}
      {proposals.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-base text-zinc-500">
            まだ個別提案書がありません。
            <br />
            <span className="text-xs">
              商談詳細の「この商談の提案書・見積書」から提案書を登録すると、ここで横断検索できます。
            </span>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-base text-zinc-500">
            条件に一致する個別提案書がありません。
            <br />
            <span className="text-xs">業界・プロダクト・社名の条件を変えてお試しください。</span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-zinc-100">
              {filtered.map((p) => (
                <ProposalRow key={p.id} p={p} />
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

function ProposalRow({ p }: { p: IndividualProposal }) {
  const isUrl = p.sourceType === "url";
  const hasFile = !!p.fileUrl && p.fileUrl !== "(リンク未登録)" && !p.fileUrl.includes(" ");
  return (
    <li className="px-5 py-3.5 flex items-start gap-3 hover:bg-zinc-50">
      <div className={cn("rounded-md p-2 shrink-0", isUrl ? "bg-sky-50" : "bg-orange-50")}>
        {isUrl ? (
          <Link2 className="h-4 w-4 text-sky-600" />
        ) : (
          <FileText className="h-4 w-4 text-orange-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">
          {p.name}
          {p.version && (
            <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">{p.version}</span>
          )}
          {isUrl && (
            <span className="ml-1.5 text-[10px] text-sky-600 font-normal">外部リンク</span>
          )}
        </p>
        <p className="flex flex-wrap items-center gap-1 text-xs text-zinc-600 mt-0.5">
          <Building2 className="h-3 w-3 shrink-0 text-zinc-400" />
          {/* 社名クリックでこの提案書が紐づく商談（Deal）詳細へ遷移 */}
          <a
            href={`/deals/${p.dealId}`}
            title={`${p.companyName} の商談「${p.dealTitle}」を開く`}
            className="font-medium text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-orange-600 hover:decoration-orange-400 transition-colors"
          >
            {p.companyName}
          </a>
          {parseIndustries(p.industry).map((ind) => (
            <Badge key={ind} variant="info" className="text-[10px]">
              {ind}
            </Badge>
          ))}
        </p>
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {p.products.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px]">
              {c}
            </Badge>
          ))}
          {p.planProposals.map((pp) => (
            <Badge key={pp} variant="warning" className="text-[10px]">
              {pp}
            </Badge>
          ))}
        </div>
        <p className="text-[10px] text-zinc-400 mt-1 truncate">
          商談: {p.dealTitle} ／ {p.uploadedByName ?? "—"} ／ {formatDate(p.createdAt)}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {isUrl ? (
          <a
            href={p.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-600 hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="h-3.5 w-3.5" /> 開く
          </a>
        ) : hasFile ? (
          <a
            href={`/api/documents/${p.id}/download`}
            className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"
          >
            <Download className="h-3.5 w-3.5" /> ダウンロード
          </a>
        ) : (
          <span className="text-xs text-zinc-400">未アップロード</span>
        )}
        <a
          href={`/deals/${p.dealId}`}
          className="text-[11px] text-zinc-500 hover:text-orange-600 hover:underline"
        >
          商談を開く →
        </a>
      </div>
    </li>
  );
}
