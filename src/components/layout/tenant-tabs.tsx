"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Building2, Check, Loader2 } from "lucide-react";
import type { MyTenant } from "@/lib/tenant-context";

/**
 * 会社タブ（Luma / リージー / 全社）
 * ------------------------------------------------------------
 * 商談・KPI・ToDo・PM など、テナントに属するデータの表示は全てこのタブに従う。
 * 企業マスタだけは2社共有なので、タブを切り替えても同じ企業が見える。
 *
 * 所属が1社のみのユーザー（大半の社員）にはタブを出さない。
 */

/** テナントごとの見た目。Tailwind は動的クラス名を拾えないので静的に持つ */
const THEME: Record<string, { activeBg: string; activeText: string; dot: string }> = {
  luma: { activeBg: "bg-orange-500", activeText: "text-white", dot: "bg-orange-500" },
  reagey: { activeBg: "bg-emerald-700", activeText: "text-white", dot: "bg-emerald-700" },
  // 全社は2社の色を混ぜたグラデーション
  __all__: {
    activeBg: "bg-gradient-to-r from-orange-500 to-emerald-600",
    activeText: "text-white",
    dot: "bg-gradient-to-r from-orange-500 to-emerald-600",
  },
};

export const ALL_TENANTS_CODE = "__all__";

export function TenantTabs({
  tenants,
  activeCode,
  canViewAll,
}: {
  tenants: MyTenant[];
  activeCode: string;
  canViewAll: boolean;
}) {
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // 所属が1社だけなら切り替える先が無いので出さない
  if (tenants.length < 2) return null;

  const tabs: { code: string; label: string }[] = [
    ...tenants.map((t) => ({ code: t.code, label: t.shortName })),
    ...(canViewAll ? [{ code: ALL_TENANTS_CODE, label: "全社" }] : []),
  ];

  async function switchTo(code: string) {
    if (code === activeCode || switching) return;
    setSwitching(code);
    setSwitchError(null);
    try {
      const res = await fetch("/api/tenant/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setSwitchError(payload?.error ?? "会社の切り替えに失敗しました");
        setSwitching(null);
        return;
      }
      // 選択中テナントは HttpOnly Cookie に保存され、ルートレイアウトを含む全ての
      // Server Component が参照する。router.refresh() だけだと Next.js のクライアント
      // キャッシュから切替前のレイアウトが再利用される場合があるため、同じURLを
      // フル再読込して新しい Cookie を確実に全リクエストへ反映する。
      window.location.reload();
    } catch {
      setSwitchError("通信エラーで会社を切り替えられませんでした");
      setSwitching(null);
    }
  }

  return (
    <div className="px-3 py-2.5 border-b border-zinc-200 bg-white">
      <div className="flex items-center gap-1.5 px-1 mb-1.5">
        <Building2 className="h-3 w-3 text-zinc-400" />
        <span className="text-[10px] font-bold tracking-wider text-zinc-400 uppercase">会社</span>
        {switching && <Loader2 className="h-3 w-3 text-zinc-400 animate-spin" />}
      </div>
      <div className="flex gap-1 rounded-lg bg-zinc-100 p-1">
        {tabs.map((t) => {
          const active = t.code === activeCode;
          const theme = THEME[t.code] ?? THEME.__all__;
          return (
            <button
              key={t.code}
              type="button"
              onClick={() => switchTo(t.code)}
              disabled={!!switching}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-all",
                active
                  ? `${theme.activeBg} ${theme.activeText} shadow-sm`
                  : "text-zinc-600 hover:bg-white hover:text-zinc-900",
                switching && !active && "opacity-50",
              )}
            >
              {!active && <span className={cn("h-1.5 w-1.5 rounded-full", theme.dot)} />}
              {active && <Check className="h-3 w-3" />}
              {t.label}
            </button>
          );
        })}
      </div>
      {switchError && (
        <p role="alert" className="mt-1.5 px-1 text-[10px] leading-tight text-red-600">
          {switchError}
        </p>
      )}
      {activeCode === ALL_TENANTS_CODE && (
        <div className="mt-1.5 px-1 text-[10px] leading-tight text-zinc-500">
          全社の合算表示です。データの登録・編集はできません。
        </div>
      )}
    </div>
  );
}
