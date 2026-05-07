/**
 * Deal の表示・判定ヘルパー（純粋関数のみ）
 *
 * クライアントコンポーネントから安全に import できるよう、
 * サーバ専用ロジック（prisma を使う excludeNGDealsWhere / getFullyLostDealIds）は
 * `@/lib/deal-status-server` に分離している。
 */

export type DealStatusValue =
  | "LEAD"
  | "HEARING"
  | "PROPOSAL"
  | "NEGOTIATION"
  | "CLOSING"
  | "WON"
  | "LOST";

export const STATUS_LABEL: Record<DealStatusValue, string> = {
  LEAD: "リード",
  HEARING: "ヒアリング",
  PROPOSAL: "提案",
  NEGOTIATION: "交渉",
  CLOSING: "クロージング",
  WON: "受注",
  LOST: "失注",
};

export function statusColor(
  status: DealStatusValue,
): "default" | "secondary" | "info" | "warning" | "success" | "danger" {
  switch (status) {
    case "LEAD":
      return "secondary";
    case "HEARING":
      return "info";
    case "PROPOSAL":
      return "info";
    case "NEGOTIATION":
      return "warning";
    case "CLOSING":
      return "warning";
    case "WON":
      return "success";
    case "LOST":
      return "danger";
  }
}

// ============================================================
// Next Action / ToDo一覧 から除外したい商談の判定（クライアント側用）
// ============================================================

/**
 * 取得済みのDealに対する「ToDo化対象から外す」判定。
 *
 * 除外対象（社長判断 2026-05）：
 *   A. bant.isNG = true（Notion で NGフラグONの商談）
 *   B. pipelineStage = 「【商談前】日程調整不可」
 *   C. 完全失注（全 DealProduct.yomiStatus が NG/失注 を含む）
 *
 * 完全失注（C）の判定は2通り：
 *   1. fullyLostDealIds の Set/list を渡してID照合（推奨・サーバから取得した結果を使う）
 *   2. d.products が渡されていれば全products基準で判定（fallback）
 *
 * @param d - 判定対象 Deal
 * @param fullyLostDealIds - サーバ側 getFullyLostDealIds() の結果（任意）
 */
export function isExcludedFromNextAction(
  d: {
    id?: string;
    bant?: unknown;
    pipelineStage?: string | null;
    products?: { yomiStatus?: string | null }[];
  },
  fullyLostDealIds?: ReadonlySet<string> | readonly string[],
): boolean {
  // A. pipelineStage
  if (d.pipelineStage === "【商談前】日程調整不可") return true;
  // B. bant.isNG
  const bant = d.bant as { isNG?: unknown } | null | undefined;
  if (bant && typeof bant === "object" && bant.isNG === true) return true;
  // C. 完全失注
  if (d.id && fullyLostDealIds) {
    const set =
      fullyLostDealIds instanceof Set
        ? fullyLostDealIds
        : new Set(fullyLostDealIds);
    if (set.has(d.id)) return true;
  } else if (d.products && d.products.length > 0) {
    // products が渡されている場合はそれで判定（fallback）
    const allLost = d.products.every((p) => {
      const y = p.yomiStatus;
      if (!y) return false;
      return /NG|失注/.test(y);
    });
    if (allLost) return true;
  }
  return false;
}
