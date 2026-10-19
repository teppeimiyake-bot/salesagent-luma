"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { DEAL_NAVIGATE_EVENT } from "./deal-navigation";

/**
 * 商談詳細ページの内容タブ（タブ化刷新）。
 *
 * 設計の考え方：
 *   13枚の機能カードを1本のスクロールに積む代わりに、「概要 / 準備・BANT /
 *   商談記録 / 見積・契約 / PM管理」の内容タブに分ける。タブバーは上部ヘッダー帯
 *   （要約カードの直下）に置き、スクロール中も画面上部に固定する。
 *   右のコンテキストサマリー（次の一手・AI分析・AIチャット）はタブの外に置き、
 *   どのタブを開いていても常に見える。
 *
 * 実装上の約束：
 *   - 全タブの中身は最初から mount し、display 切替だけで表示を変える。
 *     見積フォームなど編集途中の状態がタブ往復で消えないようにするため。
 *   - URL の ?tab= と同期する。既存リンク（PM一覧からの ?tab=pm）互換のため、
 *     タブ id は page 側で固定文字列として渡す。
 *   - 要約カードの主操作ボタンからは "luma:deal-navigate" イベントで
 *     「セクションid」だけが飛んでくる。どのタブに属すかは DOM から逆引きし、
 *     タブを切り替えてからスクロールする（ボタン側はタブ構造を知らなくてよい）。
 */

export { DEAL_NAVIGATE_EVENT };

export type DealDetailTabDef = {
  id: string;
  label: string;
  /** タブ名の右に添える件数（任意） */
  count?: number;
  /** 未対応がある等、注意を引きたいときだけ立てる印 */
  attention?: boolean;
  content: React.ReactNode;
};

export function DealDetailTabs({
  tabs,
  rail,
}: {
  tabs: DealDetailTabDef[];
  /** 右レール（常時表示のコンテキストサマリー） */
  rail: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const requested = searchParams.get("tab");
  const tab = tabs.some(t => t.id === requested) ? requested! : (tabs[0]?.id ?? "");
  const tabBarRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const pendingScroll = useRef<{ tab: string; sectionId?: string } | null>(null);
  const firstTabId = tabs[0]?.id;

  // 狭幅ではタブバー自身が横スクロールする。選択中のタブが左右に隠れないよう、
  // タブバーの scrollLeft だけを最小量動かす（scrollIntoView は縦方向の祖先まで
  // 動かしてしまうため使わない）。先頭タブは常に左端（scrollLeft=0）に戻す。
  const revealActiveTab = useCallback((activeTab: string) => {
    const nav = navRef.current;
    if (!nav) return;
    if (activeTab === firstTabId) {
      nav.scrollLeft = 0;
      return;
    }
    const button = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!button) return;
    const navRect = nav.getBoundingClientRect();
    const visibleLeft = navRect.left + nav.clientLeft;
    const visibleRight = visibleLeft + nav.clientWidth;
    const rect = button.getBoundingClientRect();
    if (rect.left < visibleLeft) {
      nav.scrollLeft = Math.max(0, Math.floor(nav.scrollLeft - (visibleLeft - rect.left)));
    } else if (rect.right > visibleRight) {
      nav.scrollLeft = Math.ceil(nav.scrollLeft + (rect.right - visibleRight));
    }
  }, [firstTabId]);

  useLayoutEffect(() => {
    revealActiveTab(tab);
  }, [tab, revealActiveTab]);

  const scrollToDestination = useCallback((sectionId?: string) => {
    if (sectionId) {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // The page scrolls inside this container, not window. An immediate reset
      // also cancels an earlier section-navigation animation.
      tabBarRef.current?.closest<HTMLElement>("[data-deal-scroll-container]")
        ?.scrollTo({ top: 0, behavior: "instant" });
    }
  }, []);

  useLayoutEffect(() => {
    const destination = pendingScroll.current;
    if (!destination || destination.tab !== tab) return;
    pendingScroll.current = null;
    // Wait for the destination panel's hidden attribute to be removed. Only
    // explicit tab/section actions request scrolling; history and refresh do not.
    scrollToDestination(destination.sectionId);
  }, [tab, scrollToDestination]);

  const select = useCallback(
    (next: string, sectionId?: string) => {
      if (!tabs.some(t => t.id === next)) return;
      pendingScroll.current = next === tab ? null : { tab: next, sectionId };
      if (next === tab) {
        scrollToDestination(sectionId);
        revealActiveTab(next);
      }
      // 先頭タブは既定なのでURLを汚さない。それ以外は ?tab= に残す（共有・リロード用）。
      const params = new URLSearchParams(searchParams.toString());
      if (next === tabs[0]?.id) params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      // Native history integrates with useSearchParams in Next.js. Switching
      // already-mounted content does not need a server refetch or DB reads.
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    },
    [searchParams, tabs, tab, scrollToDestination, revealActiveTab],
  );

  // 要約カードの主操作ボタンなど、タブの外から「このセクションへ」と言われたとき。
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const sectionId = (e as CustomEvent<{ sectionId?: string }>).detail?.sectionId;
      if (!sectionId) return;
      const el = document.getElementById(sectionId);
      if (!el) return;
      const panel = el.closest<HTMLElement>("[data-deal-tab]");
      select(panel?.dataset.dealTab ?? tab, sectionId);
    };
    window.addEventListener(DEAL_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(DEAL_NAVIGATE_EVENT, onNavigate);
  }, [tab, select]);

  return (
    <>
      {/* タブバー：上部ヘッダー帯。スクロール中は画面上部に固定される */}
      <div ref={tabBarRef} className="sticky top-0 z-30 border-b border-zinc-200 bg-white px-6 sm:px-8">
        <nav ref={navRef} aria-label="商談詳細の内容タブ" className="-mb-px flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => select(t.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative shrink-0 cursor-pointer border-b-2 px-3.5 py-3 text-[13.5px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-orange-500 font-semibold text-orange-700"
                    : "border-transparent text-zinc-500 hover:border-zinc-200 hover:text-zinc-800",
                )}
              >
                {t.label}
                {typeof t.count === "number" && (
                  <span
                    className={cn(
                      "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                      active ? "bg-orange-50 text-orange-700" : "bg-zinc-100 text-zinc-500",
                    )}
                  >
                    {t.count}
                  </span>
                )}
                {t.attention && (
                  <span
                    aria-label="未対応あり"
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle"
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="px-6 pt-5 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-x-6 gap-y-10 xl:grid-cols-12">
          {/* 左：選択中タブの内容。全タブ mount 済みで hidden 切替のみ */}
          <div className="min-w-0 xl:col-span-7">
            {tabs.map((t) => (
              <div key={t.id} data-deal-tab={t.id} hidden={t.id !== tab} className="space-y-5">
                {t.content}
              </div>
            ))}
          </div>

          {/* 右：コンテキストサマリー。タブに依らず常に表示し、スクロールでも固定 */}
          <div className="min-w-0 xl:col-span-5">
            <div className="space-y-4 xl:sticky xl:top-14">{rail}</div>
          </div>
        </div>
      </div>
    </>
  );
}
