/**
 * T17: 見積の改訂チェーン（版管理）
 *
 * 発行済み見積は上書きせず「改訂版」を新規作成する運用（T14）だが、
 * これまで改訂版は親の version をそのままコピーしていたため、
 * 一覧上で「どれが最新版か」が判別できず、ただの兄弟行として並んでいた。
 * ここでは版番号の採番と、supersedesQuoteId を辿ったチェーン構築を
 * DBに依存しない純関数として切り出す（検証スクリプトから直接叩けるようにするため）。
 */

/**
 * 改訂版の版番号を採番する。
 *   null / ""        → 親は v1 とみなして "v2"
 *   "v1" / "V1"      → "v2"
 *   "v9"             → "v10"
 *   "v1.2"           → "v1.3"
 *   それ以外（"改訂A"）→ "改訂A-改訂"
 * 例外は投げない（全域関数）。
 */
export function nextQuoteVersion(current: string | null | undefined): string {
  const raw = (current ?? "").trim();
  if (raw === "") return "v2";

  const minor = /^v(\d+)\.(\d+)$/i.exec(raw);
  if (minor) {
    const major = Number(minor[1]);
    const patch = Number(minor[2]);
    if (Number.isFinite(major) && Number.isFinite(patch)) return `v${major}.${patch + 1}`;
    return `${raw}-改訂`;
  }

  const major = /^v(\d+)$/i.exec(raw);
  if (major) {
    const n = Number(major[1]);
    if (Number.isFinite(n)) return `v${n + 1}`;
    return `${raw}-改訂`;
  }

  return `${raw}-改訂`;
}

/**
 * 一覧に出す版ラベル。
 *   ("v2", "L-20260817-0012") → "v2（L-20260817-0012 の改訂）"
 *   ("v2", null)              → "v2"
 *   (null, "L-...")           → "L-... の改訂"
 *   (null, null)              → ""
 */
export function quoteRevisionLabel(
  version: string | null,
  supersedesNumber: string | null,
): string {
  const v = (version ?? "").trim();
  const s = (supersedesNumber ?? "").trim();
  if (v && s) return `${v}（${s} の改訂）`;
  if (v) return v;
  if (s) return `${s} の改訂`;
  return "";
}

/** チェーン構築に必要な最小の見積情報 */
export type QuoteChainNode = {
  id: string;
  version: string | null;
  quoteNumber: string | null;
  status: string;
  supersedesQuoteId: string | null;
};

/**
 * 見積を改訂チェーン（親 → 子 → 孫）にまとめる。
 * - 親が一覧に無い（＝孤児）ものは、その見積自身をルートとして扱う。
 * - 万一 supersedesQuoteId に循環があっても visited で打ち切り、無限ループしない。
 * - 各チェーンの nodes は古い順（ルートが先頭、最新版が末尾）。
 * - チェーンの並びは入力の並び順（＝ルートが最初に現れた順）を保つ。
 */
export function buildQuoteChains<T extends QuoteChainNode>(
  quotes: T[],
): Array<{ rootId: string; nodes: T[] }> {
  const byId = new Map<string, T>();
  for (const q of quotes) byId.set(q.id, q);

  /** その見積が属するチェーンのルートIDを求める（循環安全） */
  function rootOf(node: T): string {
    const visited = new Set<string>([node.id]);
    let cur: T = node;
    for (;;) {
      const parentId = cur.supersedesQuoteId;
      if (!parentId) return cur.id;
      const parent = byId.get(parentId);
      // 親が一覧に無い（別商談・削除済み・権限外）なら、ここをルート扱いにする
      if (!parent) return cur.id;
      // 循環（不正データ）はその時点で打ち切る
      if (visited.has(parent.id)) return cur.id;
      visited.add(parent.id);
      cur = parent;
    }
  }

  /** ルートからの世代数（深さ）。並べ替えのキーに使う。循環安全。 */
  function depthOf(node: T): number {
    const visited = new Set<string>([node.id]);
    let depth = 0;
    let cur: T = node;
    for (;;) {
      const parentId = cur.supersedesQuoteId;
      if (!parentId) return depth;
      const parent = byId.get(parentId);
      if (!parent) return depth;
      if (visited.has(parent.id)) return depth;
      visited.add(parent.id);
      cur = parent;
      depth += 1;
    }
  }

  const order: string[] = [];
  const groups = new Map<string, Array<{ node: T; depth: number; index: number }>>();

  quotes.forEach((q, index) => {
    const rootId = rootOf(q);
    let bucket = groups.get(rootId);
    if (!bucket) {
      bucket = [];
      groups.set(rootId, bucket);
      order.push(rootId);
    }
    bucket.push({ node: q, depth: depthOf(q), index });
  });

  return order.map((rootId) => ({
    rootId,
    nodes: (groups.get(rootId) ?? [])
      // 古い順＝深さの浅い順。深さが同じ場合は入力順（一覧は createdAt desc なので後ろほど古い）
      .sort((a, b) => a.depth - b.depth || b.index - a.index)
      .map((entry) => entry.node),
  }));
}
