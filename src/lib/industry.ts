/**
 * 業界（Company.industry）の文字列パース・ユーティリティ
 *
 * 表記ルール（社長指示・2026-05）:
 * - 業界名の中の「・」（中黒）は 1つの業界名の一部。分割しない（例「広告・出版・マスコミ」で1業界）
 * - 「,」（半角カンマ）は 複数業界の区切り。これで分割して別々の業界として扱う
 *
 * DB の Company.industry の値そのものは書き換えず、解釈ロジックだけここに集約する。
 */

/**
 * 業種マスタ（選択式ドロップダウンの選択肢）。
 *
 * 設計方針（2026-06）:
 * - 既存DB(salesagent_luma)に実際に入っている業種値16種を「そのまま」中核に採用し、
 *   表記ゆれを生まないようにしている（例: 既存値は「IT」なので「IT・ソフトウェア」にしない）。
 * - Lumaの顧客層(B2B映像/SNS)向けに「教育」「飲食」「美容・サロン」を追加。
 * - 「その他」は必ず末尾に固定で含める。
 * - DBスキーマは String? のまま（enum化しない）。複数業種は「,」区切りで保存する運用を継続。
 * - マスタに無い既存値（過去の自由記入）は industrySelectOptions() で動的に補完して
 *   ドロップダウンに出すため、選択肢に無くても値が消えない。
 */
export const INDUSTRY_OPTIONS: string[] = [
  "IT",
  "製造",
  "商社",
  "小売・流通",
  "建設・設計",
  "不動産",
  "医療・福祉",
  "人材",
  "広告・出版・マスコミ",
  "エンタメ",
  "サービス",
  "コンサル",
  "金融",
  "インフラ",
  "教育",
  "飲食",
  "美容・サロン",
  "官公庁・団体",
  "その他",
];

/**
 * 単一選択ドロップダウン用の選択肢を返す。
 * - 基本は INDUSTRY_OPTIONS。
 * - currentValue がマスタに無い既存値（自由記入の名残・複数業種文字列など）の場合は
 *   先頭に追加して、保存済みの値がドロップダウンから欠落しないようにする。
 * - 「その他」は常に末尾に残す。
 */
export function industrySelectOptions(
  currentValue: string | null | undefined,
): string[] {
  const cur = (currentValue ?? "").trim();
  if (!cur || INDUSTRY_OPTIONS.includes(cur)) return INDUSTRY_OPTIONS;
  // マスタ外の既存値：先頭に補完（「その他」は末尾固定のまま）
  const head = INDUSTRY_OPTIONS.filter((o) => o !== "その他");
  return [cur, ...head, "その他"];
}

/**
 * 複数選択ピッカー用：選択肢リストを返す。
 * - 基本は `master`（DB業種マスタ）。未指定/空なら静的 INDUSTRY_OPTIONS にフォールバック。
 *   → DB未投入時やfetch失敗時でも、従来どおりの選択肢が必ず出る（後方互換）。
 * - currentValue（「,」区切りの保存値）に含まれる業種で選択肢に無いものは
 *   先頭に補完して、保存済みの値がピッカーから欠落しないようにする（データ消失防止）。
 * - 「その他」は常に末尾に残す。
 *
 * @param master DB業種マスタの名前リスト（active順）。省略時は静的リストを使う。
 */
export function industryMultiOptions(
  currentValue: string | null | undefined,
  master?: string[] | null,
): string[] {
  const base = master && master.length > 0 ? master : INDUSTRY_OPTIONS;
  // 「その他」は末尾固定にするため一旦除く
  const head = base.filter((o) => o !== "その他");
  const baseSet = new Set(base);
  const extras = parseIndustries(currentValue).filter((v) => !baseSet.has(v));
  // extras（選択肢外の既存値）を先頭、続いて業種、末尾に「その他」
  return [...extras, ...head, "その他"];
}

/**
 * 複数選択の配列を Company.industry 保存用の「,」区切り文字列に直す。
 * - trim・空除外・重複排除
 * - 空配列なら null（未設定）
 */
export function serializeIndustries(values: string[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length > 0 ? out.join(", ") : null;
}

/**
 * industry 文字列を「,」で分割し、個別の業界名の配列にする。
 * - 「,」でのみ分割（「・」は保持）
 * - 各トークンは trim、空文字は除外
 * - null/空文字は空配列
 */
export function parseIndustries(industry: string | null | undefined): string[] {
  if (!industry) return [];
  return industry
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 複数の industry 文字列から、フィルター用の業界選択肢を生成する。
 * - すべて「,」で分割・trim・空除外
 * - 重複排除
 * - 件数（その業界に属する社の延べ数）の降順、同数なら五十音順で並べる
 */
export function buildIndustryOptions(
  industries: (string | null | undefined)[],
): string[] {
  const counts = new Map<string, number>();
  for (const raw of industries) {
    for (const name of parseIndustries(raw)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([name]) => name);
}

/**
 * ある社の industry が、指定された業界チップに該当するか判定する。
 * その社の industry を「,」で分割した集合のいずれかが selected と一致したらヒット。
 */
export function matchesIndustry(
  industry: string | null | undefined,
  selected: string,
): boolean {
  return parseIndustries(industry).includes(selected);
}
