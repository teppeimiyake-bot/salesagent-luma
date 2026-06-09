"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Users, ChevronRight, MapPin, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/ui/company-logo";
import { DeleteButton } from "@/components/shared/delete-button";
import { formatJPY } from "@/lib/utils";
import { buildIndustryOptions, matchesIndustry } from "@/lib/industry";

/**
 * 企業一覧（業種フィルタ付き）。
 * サーバー側で集計済みの行データを受け取り、業種チップでクライアントフィルタする。
 * 業種は「,」区切りの複数業種に対応（matchesIndustry / buildIndustryOptions を利用）。
 */

export type CompanyRow = {
  id: string;
  name: string;
  industry: string | null;
  logoUrl: string | null;
  logoColor: string | null;
  address: string | null;
  phoneNumber: string | null;
  dealCount: number;
  activeCount: number;
  contactCount: number;
  proposedAmount: number;
  primaryProducts: { productName: string }[];
  restProducts: number;
};

const ALL = "__all__";
const NONE = "__none__";

export function CompaniesList({
  companies,
  canEdit,
}: {
  companies: CompanyRow[];
  canEdit: boolean;
}) {
  const [selected, setSelected] = useState<string>(ALL);

  // 業種チップ（件数降順）。複数業種・「・」保持は industry.ts のルールに従う。
  const industryOptions = useMemo(
    () => buildIndustryOptions(companies.map((c) => c.industry)),
    [companies],
  );
  const hasUnset = useMemo(
    () => companies.some((c) => !c.industry || !c.industry.trim()),
    [companies],
  );

  const filtered = useMemo(() => {
    if (selected === ALL) return companies;
    if (selected === NONE)
      return companies.filter((c) => !c.industry || !c.industry.trim());
    return companies.filter((c) => matchesIndustry(c.industry, selected));
  }, [companies, selected]);

  return (
    <>
      {/* 業種フィルタ */}
      {industryOptions.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-zinc-500 mr-1">業種</span>
          <Chip
            label="すべて"
            active={selected === ALL}
            onClick={() => setSelected(ALL)}
          />
          {industryOptions.map((opt) => (
            <Chip
              key={opt}
              label={opt}
              active={selected === opt}
              onClick={() => setSelected(opt)}
            />
          ))}
          {hasUnset && (
            <Chip
              label="未設定"
              active={selected === NONE}
              onClick={() => setSelected(NONE)}
            />
          )}
        </div>
      )}

      {/* テーブルヘッダ */}
      <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-200 bg-zinc-50/50">
        <div className="col-span-4">企業</div>
        <div className="col-span-2">所在地</div>
        <div className="col-span-1 text-right">商談</div>
        <div className="col-span-1 text-right">連絡先</div>
        <div className="col-span-3 text-right">提案金額合計</div>
        <div className="col-span-1"></div>
      </div>

      <div className="divide-y divide-zinc-100">
        {filtered.map((c) => (
          <Link
            key={c.id}
            href={`/companies/${c.id}`}
            className="grid grid-cols-12 gap-4 px-5 py-4 hover:bg-emerald-50/40 transition-colors group items-center"
          >
            {/* 企業名＋業種＋プロダクト */}
            <div className="col-span-12 md:col-span-4 min-w-0">
              <div className="flex items-center gap-3">
                <CompanyLogo
                  name={c.name}
                  logoUrl={c.logoUrl}
                  logoColor={c.logoColor}
                  size="md"
                />
                <div className="min-w-0">
                  <p className="font-bold text-lg truncate group-hover:text-emerald-700">
                    {c.name}
                  </p>
                  {c.industry && (
                    <p className="text-sm text-zinc-500 truncate">{c.industry}</p>
                  )}
                </div>
              </div>
              {c.primaryProducts.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 ml-13 pl-13">
                  {c.primaryProducts.map((p, i) => (
                    <Badge key={i} variant="outline" className="text-[11px]">
                      {p.productName}
                    </Badge>
                  ))}
                  {c.restProducts > 0 && (
                    <Badge variant="secondary" className="text-[11px]">
                      +{c.restProducts}
                    </Badge>
                  )}
                </div>
              )}
            </div>

            {/* 所在地 */}
            <div className="hidden md:block col-span-2 text-xs text-zinc-600 min-w-0">
              {c.address ? (
                <div className="space-y-1">
                  <p className="inline-flex items-center gap-1 truncate">
                    <MapPin className="h-3 w-3 shrink-0 text-zinc-400" />
                    {c.address.split(/[市区町村]/)[0]}
                  </p>
                  {c.phoneNumber && (
                    <p className="inline-flex items-center gap-1 text-zinc-500">
                      <Phone className="h-3 w-3 shrink-0" />
                      {c.phoneNumber}
                    </p>
                  )}
                </div>
              ) : (
                <span className="text-zinc-400">—</span>
              )}
            </div>

            {/* 商談数 */}
            <div className="hidden md:block col-span-1 text-right">
              <div className="inline-flex items-baseline gap-1">
                <span className="text-xl font-bold tabular-nums">{c.dealCount}</span>
                <span className="text-[10px] text-zinc-400">件</span>
              </div>
              {c.activeCount > 0 && (
                <p className="text-[10px] text-emerald-600">{c.activeCount} 進行</p>
              )}
            </div>

            {/* 連絡先数 */}
            <div className="hidden md:block col-span-1 text-right">
              <div className="inline-flex items-baseline gap-1">
                <Users className="h-3 w-3 text-zinc-400" />
                <span className="text-xl font-bold tabular-nums">
                  {c.contactCount}
                </span>
              </div>
            </div>

            {/* 提案金額合計 */}
            <div className="hidden md:block col-span-3 text-right">
              {c.proposedAmount > 0 ? (
                <>
                  <p className="text-xl font-bold tabular-nums text-emerald-700">
                    {formatJPY(c.proposedAmount)}
                  </p>
                  <p className="text-[10px] text-zinc-400">進行中の提案金額合計</p>
                </>
              ) : (
                <span className="text-sm text-zinc-400">—</span>
              )}
            </div>

            <div className="hidden md:flex md:col-span-1 justify-end items-center gap-1">
              {canEdit && (
                <DeleteButton
                  endpoint={`/api/companies/${c.id}`}
                  targetLabel={c.name}
                  extraNote={
                    c.dealCount > 0
                      ? `この企業に紐づく商談 ${c.dealCount} 件もまとめてゴミ箱に移動します。`
                      : undefined
                  }
                />
              )}
              <ChevronRight className="h-5 w-5 text-zinc-300 group-hover:text-emerald-500 transition-colors" />
            </div>
          </Link>
        ))}
        {filtered.length === 0 && (
          <div className="px-5 py-12 text-center text-base text-zinc-500">
            {companies.length === 0
              ? "企業が登録されていません。"
              : "この業種に該当する企業はありません。"}
          </div>
        )}
      </div>
    </>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
        active
          ? "bg-emerald-600 text-white border-emerald-600"
          : "bg-white text-zinc-600 border-zinc-200 hover:bg-emerald-50 hover:border-emerald-200"
      }`}
    >
      {label}
    </button>
  );
}
