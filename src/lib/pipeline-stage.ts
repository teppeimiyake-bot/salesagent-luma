/**
 * 商談プロセスステージ（リージー独自）
 * Deal.pipelineStage に格納する文字列値の集約。
 * 既存の Deal.status (LEAD/HEARING/...) とは別軸で、より細かい商談プロセス進捗を表す。
 *
 * 2026-05-01 更新：DB の `PipelineStage` テーブルへ移行。
 *   - 管理画面（/admin/pipeline-stages）で CRUD 可能
 *   - 以下のハードコード PIPELINE_STAGES は DB が空の場合のフォールバック兼、SSR 初期表示用
 *   - クライアント側は API `/api/pipeline-stages` から取得した一覧を優先
 */

export type StageGroup = "before" | "after" | "contract";

export interface PipelineStageDef {
  /** DBに格納する値 */
  value: string;
  /** UI 表示ラベル（短縮）。値そのものが既に表示用なので value と同じが多い */
  label: string;
  /** グループ */
  group: StageGroup;
  /** badge variant（@/components/ui/badge の variants と一致） */
  badge: "info" | "secondary" | "warning" | "success" | "danger" | "outline";
  /** タグの背景色（list 表示用） */
  bg: string;
  /** テキスト色 */
  text: string;
}

/**
 * DB の PipelineStage テーブル行（API レスポンス想定）
 */
export interface PipelineStageRow {
  id: string;
  value: string;
  label: string;
  group: string; // before / after / contract
  badgeBg: string;
  badgeText: string;
  active: boolean;
  sortOrder: number;
}

export const PIPELINE_STAGES: PipelineStageDef[] = [
  // 商談前（青系）
  { value: "【商談前】商談予定", label: "【商談前】商談予定", group: "before", badge: "info", bg: "bg-sky-100", text: "text-sky-800" },
  { value: "【商談前】日程調整不可", label: "【商談前】日程調整不可", group: "before", badge: "secondary", bg: "bg-zinc-200", text: "text-zinc-700" },
  { value: "【商談前】催促2回送信済", label: "【商談前】催促2回送信済", group: "before", badge: "warning", bg: "bg-amber-100", text: "text-amber-800" },
  // 商談後（緑系）
  { value: "【商談後】追いかけ1回目", label: "【商談後】追いかけ1回目", group: "after", badge: "info", bg: "bg-emerald-50", text: "text-emerald-700" },
  { value: "【商談後】追いかけ2回目", label: "【商談後】追いかけ2回目", group: "after", badge: "info", bg: "bg-emerald-50", text: "text-emerald-700" },
  { value: "【商談後】追いかけ3回目", label: "【商談後】追いかけ3回目", group: "after", badge: "info", bg: "bg-emerald-100", text: "text-emerald-800" },
  { value: "【商談後】追いかけ4回目", label: "【商談後】追いかけ4回目", group: "after", badge: "warning", bg: "bg-emerald-100", text: "text-emerald-800" },
  { value: "【商談後】追いかけ5回目", label: "【商談後】追いかけ5回目", group: "after", badge: "warning", bg: "bg-emerald-200", text: "text-emerald-900" },
  { value: "【商談後】追いかけ6回目以上", label: "【商談後】追いかけ6回目以上", group: "after", badge: "danger", bg: "bg-emerald-200", text: "text-emerald-900" },
  { value: "【商談後】稟議中", label: "【商談後】稟議中", group: "after", badge: "warning", bg: "bg-teal-100", text: "text-teal-800" },
  { value: "【商談後】企画中", label: "【商談後】企画中", group: "after", badge: "info", bg: "bg-teal-100", text: "text-teal-800" },
  { value: "【商談後】トスなし", label: "【商談後】トスなし", group: "after", badge: "secondary", bg: "bg-zinc-100", text: "text-zinc-600" },
  // 契約系（オレンジ・紫）
  { value: "契約書チェック中", label: "契約書チェック中", group: "contract", badge: "warning", bg: "bg-orange-100", text: "text-orange-800" },
  { value: "契約書送付中（返送待ち）", label: "契約書送付中（返送待ち）", group: "contract", badge: "warning", bg: "bg-green-100", text: "text-green-800" },
];

export const STAGE_GROUP_LABEL: Record<StageGroup, string> = {
  before: "商談前",
  after: "商談後",
  contract: "契約",
};

export function findStage(value: string | null | undefined): PipelineStageDef | null {
  if (!value) return null;
  return PIPELINE_STAGES.find((s) => s.value === value) ?? null;
}

/**
 * DB 行 → UI 描画向け（PipelineStageDef 互換）に変換。
 * group ／badge 種別は不明な場合は適切なフォールバック。
 */
export function rowToStageDef(row: PipelineStageRow): PipelineStageDef {
  const group: StageGroup = (row.group === "before" || row.group === "after" || row.group === "contract")
    ? row.group
    : "after";
  return {
    value: row.value,
    label: row.label || row.value,
    group,
    badge: "info",
    bg: row.badgeBg || "bg-zinc-100",
    text: row.badgeText || "text-zinc-700",
  };
}

/**
 * value から DB 行を引いて UI 表示用に変換。見つからない場合はハードコード fallback。
 * 表示時のみに使う（DB行配列を引数で渡す）。
 */
export function findStageFromRows(
  value: string | null | undefined,
  rows: PipelineStageRow[],
): PipelineStageDef | null {
  if (!value) return null;
  const row = rows.find((r) => r.value === value);
  if (row) return rowToStageDef(row);
  return findStage(value);
}
