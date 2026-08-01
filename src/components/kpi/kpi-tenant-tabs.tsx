"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * KPI画面の会社タブ（Luma / リージー）
 * ------------------------------------------------------------
 * サイドバーの会社タブ（Cookie）とは独立して、URL の ?tenant= で表示対象を切り替える。
 * 経営視点で「Luma の数字を見た直後にリージーの数字を見る」用途を想定しているため、
 * サイドバーの選択（＝商談を登録する先）は変えない。
 *
 * 会計年度が会社ごとに違う（Luma=6月始まり / リージー=1月始まり）ので、
 * タブを切り替えると年度セレクタの示す期間も切り替わる。
 * 所属が1社だけのユーザーには表示しない。
 */
const THEME: Record<string, { active: string; dot: string }> = {
  luma: { active: "bg-orange-500 text-white shadow-sm", dot: "bg-orange-500" },
  reagey: { active: "bg-emerald-700 text-white shadow-sm", dot: "bg-emerald-700" },
};

export function KpiTenantTabs({
  tenants,
  selectedCode,
}: {
  tenants: { code: string; shortName: string; fiscalYearStartMonth: number }[];
  selectedCode: string;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  if (tenants.length < 2) return null;

  function buildHref(code: string) {
    const params = new URLSearchParams(search);
    params.set("tenant", code);
    // 会計年度の区切りが会社ごとに違うため、会社を変えたら年度指定は捨てて既定年度に戻す
    params.delete("year");
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex items-center gap-2">
      <Building2 className="h-3.5 w-3.5 text-zinc-400" />
      <div className="flex gap-1 rounded-lg bg-zinc-100 p-1">
        {tenants.map((t) => {
          const active = t.code === selectedCode;
          const theme = THEME[t.code] ?? THEME.luma;
          return (
            <Link
              key={t.code}
              href={buildHref(t.code)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-all",
                active ? theme.active : "text-zinc-600 hover:bg-white hover:text-zinc-900",
              )}
            >
              {!active && <span className={cn("h-1.5 w-1.5 rounded-full", theme.dot)} />}
              {t.shortName}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
