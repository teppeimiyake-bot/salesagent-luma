const MAX_JSON_LENGTH = 100_000;
const MAX_JSON_LAYERS = 3;
const MAX_DEPTH = 24;
const MAX_NODES = 2_000;
const UNREADABLE = "内容を読み取れませんでした。";

const labels: Readonly<Record<string, string>> = {
  action: "行動",
  actions: "行動",
  reason: "理由",
  reasons: "理由",
  rationale: "理由",
  expected_outcome: "期待成果",
  expected_outcomes: "期待成果",
  outcome: "成果",
  outcomes: "成果",
  risk: "リスク",
  risks: "リスク",
  winning_scenario: "勝ち筋",
  strategy: "戦略",
  differentiation: "差別化",
  closing_plan: "クロージング計画",
  title: "見出し",
  summary: "要約",
  description: "内容",
  detail: "詳細",
  details: "詳細",
  objective: "目的",
  goal: "目標",
  condition: "条件",
  conditions: "条件",
  next_action: "次の行動",
  next_actions: "次の行動",
  deadline: "期限",
  timing: "時期",
  owner: "担当",
  priority: "優先度",
  impact: "影響",
  note: "補足",
  notes: "補足",
};

/** Decode only complete JSON containers; prose, invalid JSON and scalars stay intact. */
function decodeContainer(text: string): unknown {
  if (text.length > MAX_JSON_LENGTH) return text;
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
  let candidate = fenced?.[1] ?? text.trim();
  for (let layer = 0; layer < MAX_JSON_LAYERS; layer++) {
    if (!['{', '[', '"'].includes(candidate[0])) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return text;
    }
    if (parsed !== null && typeof parsed === "object") return parsed;
    if (typeof parsed !== "string") return text;
    candidate = parsed.trim();
  }
  return text;
}

function fieldLabel(key: string): string {
  const normalized = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
  if (Object.hasOwn(labels, normalized)) return labels[normalized];
  const week = normalized.match(/^week[_ -]?(\d+)$/u);
  if (week) return `${week[1]}週目`;
  const step = normalized.match(/^(?:step|phase)[_ -]?(\d+)$/u);
  if (step) return `${normalized.startsWith("phase") ? "段階" : "手順"}${step[1]}`;
  // Keep human-readable Japanese/date headings, but do not expose unknown schema keys.
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(key)
    || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/u.test(key) ? key : "";
}

/**
 * Turn AI strategy fields into displayable prose before sentence-based evidence guards.
 * Existing prose is unchanged. Arrays use paragraphs, never generated list numbers.
 * Parent labels repeat on every content line so later guards can distinguish all
 * reasons/risks in arrays and nested plans. Blank paragraph separators stay intact.
 * Unknown schema fields keep their values; known labels and explicit week/step keys
 * retain their meaning. Invalid/oversized encoded JSON is left intact, not repaired.
 * Non-JSON objects, cycles and traversal limits produce an explicit unreadable marker;
 * getters, toJSON/toString methods and code embedded in text are never executed.
 */
export function normalizeStrategyText(value: unknown): string {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): string => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return UNREADABLE;
    if (entry == null) return "";
    if (typeof entry === "string") {
      const decoded = decodeContainer(entry);
      return decoded === entry ? entry : visit(decoded, depth + 1);
    }
    if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") return String(entry);
    if (typeof entry !== "object") return UNREADABLE;
    if (ancestors.has(entry)) return UNREADABLE;
    const prototype = Object.getPrototypeOf(entry);
    // JSON values may come from another realm (for example a worker or VM).
    // Its Object.prototype differs by identity but still has a null parent.
    if (!Array.isArray(entry) && prototype !== null && Object.getPrototypeOf(prototype) !== null) return UNREADABLE;
    ancestors.add(entry);
    try {
      const result: string[] = [];
      for (const key of Object.keys(entry)) {
        if (nodes >= MAX_NODES) {
          result.push(UNREADABLE);
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        const text = descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : UNREADABLE;
        if (!text) continue;
        const label = Array.isArray(entry) ? "" : fieldLabel(key);
        result.push(label ? text.split(/(\r\n|\r|\n)/u)
          .map((line, index) => index % 2 === 0 && line.trim() ? `${label}：${line}` : line).join("") : text);
      }
      return result.join(Array.isArray(entry) ? "\n\n" : "\n");
    } finally {
      ancestors.delete(entry);
    }
  };
  return visit(value, 0);
}
