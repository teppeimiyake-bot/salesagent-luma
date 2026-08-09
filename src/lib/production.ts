/**
 * 受注企業の案件進捗（PMタブ・機能4）の共通ロジック・ラベルマップ。
 *
 * DBは enum ProductionStatus（英大文字）で保持し、UI表示はこのモジュールで
 * 日本語ラベル（Notion PMボード「Luma PM-dev」準拠）へ変換する。
 *
 * ステータスはカテゴリで体系が違う：
 *   映像 / CATV / アライアンス … 制作の進行段階（撮影前 → … → 納品済み）
 *   SNS                        … 継続契約なので「契約中 / 解約」の2択
 * 混ぜて出すと運用上まぎらわしいので、UIは必ず statusesForCategory() で出し分ける。
 */

// ---------- 映像系（制作進行）----------
export const VIDEO_PRODUCTION_STATUSES = [
  "BEFORE_SHOOT",
  "EDITING",
  "REVISING",
  "CLIENT_REVIEW",
  "REVISION_WAIT",
  "NEAR_DELIVERY",
  "DELIVERED",
] as const;

// ---------- SNS（継続契約）----------
export const SNS_PRODUCTION_STATUSES = ["CONTRACTED", "CANCELLED"] as const;

// ---------- enum 値（Prisma enum メンバ名と一致させる） ----------
export const PRODUCTION_STATUSES = [
  ...VIDEO_PRODUCTION_STATUSES,
  ...SNS_PRODUCTION_STATUSES,
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
  CONTRACTED: "契約中",
  CANCELLED: "解約",
};

/** そのカテゴリで選べるステータス。SNS だけ契約中/解約の2択。 */
export function statusesForCategory(category: string | null | undefined): readonly ProductionStatus[] {
  return category === "SNS" ? SNS_PRODUCTION_STATUSES : VIDEO_PRODUCTION_STATUSES;
}

/**
 * 一覧の初期表示で隠すステータス。
 * 終わった案件（納品済み／解約）が積み上がって進行中の案件が埋もれるのを防ぐ。
 */
export function defaultHiddenStatus(category: string | null | undefined): ProductionStatus {
  return category === "SNS" ? "CANCELLED" : "DELIVERED";
}

// ---------- ステータス配色 ----------
/**
 * ステータスごとの色。制作の進み方に沿って色相を動かしているので、
 * 一覧をざっと眺めたときに「どの段階に案件が溜まっているか」が色で分かる。
 *   撮影前(灰) → 編集中(青) → 修正中(琥珀) → 修正待ち(橙) → 先方チェック待ち(紫)
 *   → 納品間近(青緑) → 納品済み(緑)
 * SNSは 契約中(緑) / 解約(灰) の2色。映像系と同じタブに並ぶことはないので色は重複してよい。
 *
 * Tailwind はクラス名を静的に走査するため、必ず完全なクラス文字列で持つこと
 * （`bg-${color}-50` のような組み立ては本番ビルドで消える）。
 */
type StatusStyle = {
  /** 先頭のドット */
  dot: string;
  /** バッジ/セレクトの下地 */
  pill: string;
  /** 絞り込みチップ（選択中） */
  chip: string;
};

export const PRODUCTION_STATUS_STYLE: Record<ProductionStatus, StatusStyle> = {
  BEFORE_SHOOT: {
    dot: "bg-slate-400",
    pill: "bg-slate-50 text-slate-700 ring-slate-200",
    chip: "bg-slate-100 text-slate-800 ring-slate-300",
  },
  EDITING: {
    dot: "bg-sky-500",
    pill: "bg-sky-50 text-sky-700 ring-sky-200",
    chip: "bg-sky-100 text-sky-800 ring-sky-300",
  },
  REVISING: {
    dot: "bg-amber-500",
    pill: "bg-amber-50 text-amber-700 ring-amber-200",
    chip: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  REVISION_WAIT: {
    dot: "bg-orange-500",
    pill: "bg-orange-50 text-orange-700 ring-orange-200",
    chip: "bg-orange-100 text-orange-800 ring-orange-300",
  },
  CLIENT_REVIEW: {
    dot: "bg-violet-500",
    pill: "bg-violet-50 text-violet-700 ring-violet-200",
    chip: "bg-violet-100 text-violet-800 ring-violet-300",
  },
  NEAR_DELIVERY: {
    dot: "bg-teal-500",
    pill: "bg-teal-50 text-teal-700 ring-teal-200",
    chip: "bg-teal-100 text-teal-800 ring-teal-300",
  },
  DELIVERED: {
    dot: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    chip: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  CONTRACTED: {
    dot: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    chip: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  CANCELLED: {
    dot: "bg-zinc-300",
    pill: "bg-zinc-50 text-zinc-500 ring-zinc-200",
    chip: "bg-zinc-200 text-zinc-700 ring-zinc-300",
  },
};

// ---------- Badge variant ヘルパー（旧UI互換） ----------
export function productionStatusVariant(
  s: ProductionStatus,
): "success" | "warning" | "info" | "secondary" {
  switch (s) {
    case "DELIVERED":
    case "CONTRACTED":
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
