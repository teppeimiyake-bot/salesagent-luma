"use client";

import { cn } from "@/lib/utils";
import { SPOT_FILTERS, type SpotFilterKey, type SpotFilterDef } from "@/lib/payments-ui";

export type SpotFilterState = Record<SpotFilterKey, string[]>;

/**
 * スポット入金のフィルタバー。
 * 支払時期 / 契約締結 / 請求書送付 / 着金状況 を各々複数選択トグルで絞り込む。
 * yomi-filter.tsx の見た目（「すべて」+ 各値トグル）に寄せている。
 * 状態は親（SpotTable）が保持。クライアント側フィルタ。
 */
export function SpotFilters({
  state,
  onChange,
}: {
  state: SpotFilterState;
  onChange: (next: SpotFilterState) => void;
}) {
  function setRow(def: SpotFilterDef, next: string[]) {
    onChange({ ...state, [def.key]: next });
  }

  return (
    <div className="space-y-1.5">
      {SPOT_FILTERS.map((def) => {
        const selected = state[def.key];
        const isAll = selected.length === def.values.length;
        return (
          <div key={def.key} className="flex items-center gap-1.5 overflow-x-auto py-0.5">
            <span className="inline-flex items-center text-xs text-zinc-500 px-1 shrink-0 w-[72px]">
              {def.label}:
            </span>
            <button
              type="button"
              onClick={() => setRow(def, [...def.values])}
              title="すべて表示"
              className={cn(
                "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
                isAll
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
              )}
            >
              すべて
            </button>
            {def.values.map((v) => {
              const active = selected.includes(v);
              const tone = def.tone[v];
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() =>
                    setRow(
                      def,
                      active ? selected.filter((x) => x !== v) : [...selected, v],
                    )
                  }
                  className={cn(
                    "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
                    active ? tone.active : tone.idle,
                  )}
                >
                  {def.labelMap[v]}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** フィルタ初期状態。defaultSelected があればそれ、無ければ全選択。 */
export function defaultSpotFilterState(): SpotFilterState {
  const out = {} as SpotFilterState;
  for (const def of SPOT_FILTERS) {
    out[def.key] = [...(def.defaultSelected ?? def.values)];
  }
  return out;
}
