/**
 * 受注企業の案件進捗（PMタブ・機能4）の共通ロジック・ラベルマップ。
 *
 * DBは enum ProductionStatus（英大文字）で保持し、UI表示はこのモジュールで
 * 日本語ラベル（Notion PMボード「Luma PM-dev」準拠）へ変換する。
 */

// ---------- enum 値（Prisma enum メンバ名と一致させる） ----------
export const PRODUCTION_STATUSES = [
  "BEFORE_SHOOT",
  "EDITING",
  "REVISING",
  "CLIENT_REVIEW",
  "REVISION_WAIT",
  "NEAR_DELIVERY",
  "DELIVERED",
] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

// ---------- 日本語ラベル（Notion PMボード準拠） ----------
export const PRODUCTION_STATUS_LABEL: Record<ProductionStatus, string> = {
  BEFORE_SHOOT: "撮影前",
  EDITING: "編集中",
  REVISING: "修正中",
  CLIENT_REVIEW: "先方チェック待ち",
  REVISION_WAIT: "修正待ち",
  NEAR_DELIVERY: "納品間近",
  DELIVERED: "納品済み",
};

// ---------- Badge variant ヘルパー（UI色分け） ----------
export function productionStatusVariant(
  s: ProductionStatus,
): "success" | "warning" | "info" | "secondary" {
  switch (s) {
    case "DELIVERED":
      return "success";
    case "NEAR_DELIVERY":
      return "warning";
    case "CLIENT_REVIEW":
    case "REVISION_WAIT":
      return "info";
    default:
      return "secondary";
  }
}

/** 日本語ラベル → enum 逆引き（Notion取込・将来のCSV取込用）。不明は BEFORE_SHOOT。 */
export function parseProductionStatus(label: string | null | undefined): ProductionStatus {
  const t = (label ?? "").trim();
  const found = (Object.keys(PRODUCTION_STATUS_LABEL) as ProductionStatus[]).find(
    (k) => PRODUCTION_STATUS_LABEL[k] === t,
  );
  return found ?? "BEFORE_SHOOT";
}
