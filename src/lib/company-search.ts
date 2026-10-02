/**
 * 企業名検索の表記ゆれ吸収。
 *
 * 「正式名称（株式会社◯◯）で入れると0件なのに、1文字消すとヒットする」
 * という報告（2026-09 社長）への対処。原因は素の部分一致検索で、
 *   - 全角/半角（Ｌｕｍａ / Luma、ｶﾅ / カナ）
 *   - 大文字/小文字、ひらがな/カタカナ
 *   - 法人格の有無・前後位置（株式会社◯◯ / ◯◯株式会社 / ㈱◯◯ / ◯◯）
 *   - 空白・中黒・ハイフン等の記号
 * が1文字でも食い違うと落ちること。
 *
 * ここでは検索語と社名の双方を正規化して突き合わせ、さらに
 * 「正規化しても0件なら末尾を1文字ずつ削って再検索する」フォールバックを入れる。
 * これで “全部入れると0件だが1文字消すと出る” という状態は原理的に起きない。
 */

/** 法人格トークン（前置・後置どちらでも落とす） */
const CORP_TOKENS =
  /株式会社|（株）|\(株\)|㈱|有限会社|（有）|\(有\)|㈲|合同会社|（同）|\(同\)|合資会社|合名会社|一般社団法人|公益社団法人|一般財団法人|公益財団法人|社団法人|財団法人|特定非営利活動法人|医療法人|学校法人|宗教法人|独立行政法人|社会福祉法人|ＮＰＯ法人|NPO法人/g;

/** 空白・記号（表記ゆれの温床） */
const NOISE = /[\s　・･,.，。、'’`"”\-‐‑–—―－_/／\\|()（）\[\]「」『』【】{}&＆+＋:：;；!！?？*＊※~〜^＾#＠@]/g;

/**
 * 検索用の正規化文字列を作る。
 * NFKC で全角英数・半角カナを揃え、ひらがな→カタカナ、記号を落として小文字化。
 * stripCorp = true なら法人格も落とす（既定）。
 */
export function normalizeSearchText(
  raw: string | null | undefined,
  stripCorp = true,
): string {
  if (!raw) return "";
  let s = raw.normalize("NFKC");
  if (stripCorp) s = s.replace(CORP_TOKENS, "");
  s = s.replace(NOISE, "");
  // ひらがな → カタカナ（読み入力の揺れ吸収）
  s = s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  return s.toLowerCase().trim();
}

/**
 * 正規化クエリのフォールバック候補（長い順）。
 * 完全一致で拾えないときに末尾を1文字ずつ削る。削りすぎて無関係な企業を
 * 拾わないよう、元の長さの6割・最低2文字までに留める。
 */
function queryCandidates(nq: string): string[] {
  // 1〜2文字の短いクエリは削らずそのまま使う（floor がクエリ長を超えないようにする）
  const floor = Math.min(nq.length, Math.max(2, Math.ceil(nq.length * 0.6)));
  const out: string[] = [];
  for (let len = nq.length; len >= floor; len--) out.push(nq.slice(0, len));
  return out;
}

export type NamedRecord = { name: string };

/**
 * 企業リストを検索語で絞り込む（前方一致 → 部分一致の順に並べる）。
 * 表記ゆれを吸収し、0件のときだけ段階的に語尾を削って再試行する。
 */
export function matchCompaniesByName<T extends NamedRecord>(
  items: T[],
  query: string,
  limit = 20,
): T[] {
  // core = 法人格を落とした形（「株式会社◯◯」と「◯◯株式会社」を同一視）
  // full = 法人格を残した形（「株式会社」だけで探したときにも当てる）
  const qCore = normalizeSearchText(query);
  const qFull = normalizeSearchText(query, false);
  if (!qCore && !qFull) return items.slice(0, limit);

  // 社名の正規化は1回だけ（候補を削って再試行するため使い回す）
  const normalized = items.map((item) => ({
    item,
    core: normalizeSearchText(item.name),
    full: normalizeSearchText(item.name, false),
  }));

  const coreCandidates = queryCandidates(qCore);
  const fullCandidates = queryCandidates(qFull);
  const steps = Math.max(coreCandidates.length, fullCandidates.length);

  for (let i = 0; i < steps; i++) {
    const c = coreCandidates[i];
    const f = fullCandidates[i];
    const startsWith: T[] = [];
    const includes: T[] = [];
    for (const { item, core, full } of normalized) {
      if ((c && core.startsWith(c)) || (f && full.startsWith(f))) startsWith.push(item);
      else if ((c && core.includes(c)) || (f && full.includes(f))) includes.push(item);
    }
    if (startsWith.length > 0 || includes.length > 0) {
      return [...startsWith, ...includes].slice(0, limit);
    }
  }
  return [];
}
