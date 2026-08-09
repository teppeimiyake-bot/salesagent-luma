"use client";

import { ChevronDown } from "lucide-react";
import {
  PRODUCTION_STATUS_LABEL,
  PRODUCTION_STATUS_STYLE,
  statusesForCategory,
  type ProductionStatus,
} from "@/lib/production";

/** 読み取り専用のステータス表示。色つきドット＋淡い下地。 */
export function StatusPill({
  status,
  className = "",
}: {
  status: ProductionStatus;
  className?: string;
}) {
  const s = PRODUCTION_STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${s.pill} ${className}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {PRODUCTION_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * 編集可能なステータス。見た目は StatusPill と揃え、クリックで素の <select> を開く。
 *
 * Radix Select ではなくネイティブ select を透明に重ねている：
 * 行の中に何十個も並ぶセルなので、ポータルを開くタイプのコンポーネントを
 * 並べるより軽く、キーボード操作もOSに任せられる。
 */
export function StatusSelect({
  status,
  category,
  onChange,
  disabled = false,
}: {
  status: ProductionStatus;
  category: string | null;
  onChange: (next: ProductionStatus) => void;
  disabled?: boolean;
}) {
  const s = PRODUCTION_STATUS_STYLE[status];
  const options = statusesForCategory(category);

  return (
    <span
      className={`relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-2.5 pr-1.5 text-xs font-medium ring-1 ring-inset transition-shadow ${s.pill} ${
        disabled ? "" : "cursor-pointer hover:ring-2"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {PRODUCTION_STATUS_LABEL[status]}
      <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
      <select
        aria-label="ステータス"
        disabled={disabled}
        value={status}
        onChange={(e) => onChange(e.target.value as ProductionStatus)}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {PRODUCTION_STATUS_LABEL[o]}
          </option>
        ))}
      </select>
    </span>
  );
}
