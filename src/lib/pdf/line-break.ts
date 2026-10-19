/**
 * @react-pdf/renderer の改行位置を決めるハイフネーションコールバック（日本語向け）。
 *
 * react-pdf（@react-pdf/textkit）は、テキストを半角スペースで「語」に分け、語ごとにこの
 * コールバックで「音節」に分割する。音節の間は改行してよい位置になるが、そこで改行すると
 * 行末に「-」を自動で足す。以前の `(w) => [w]` は日本語の文全体を1語のまま渡していたため、
 * 列幅を超えると語の途中に「-」を挟んで折り返したり（例「…コンテンツ-制作…」）、区切りの無い
 * 長いかなが隣の列へはみ出したりしていた。
 *
 * ここでは次のように分割する。
 *   - かな・漢字・全角記号などは1文字ずつ区切れるようにする（行頭・行末禁則の文字は前後とくっつける）。
 *   - 英数字の並びは1語として扱い、途中では改行しない（英語の語はスペース位置で折り返す）。
 *     ただし LONG_LATIN_RUN 文字を超える区切りの無い並び（URL・ID など）は、列からはみ出さない
 *     よう1文字ずつ区切れるようにする。
 *   - 区切り同士の間には空文字 "" の音節を挟む。textkit は空文字を幅0の「glue」として扱い、
 *     そこでの改行ではハイフンを足さない（ハイフンを足すのは音節どうしが直接並んだときだけ）。
 *
 * textkit はこのコールバックを呼ぶ前に、文字列を文字種ごとのラン（漢字｜かな｜英字）と JSX の文字列
 * （`{a}{b}` など）ごとに分け、ランの境目にもハイフン付きの改行位置を置く。かな・漢字で始まる語は
 * 先頭にも "" を置いてそこをハイフン無しの改行位置にするが、英数字や小書きかな・句読点で始まる場合は
 * 置かない（段落先頭に幅0の改行位置があると、1語で列幅を超えるときに空行ができるため。小書きかな等は
 * 行頭禁則）。そのため「編集データは｜Adobe」「立ち会｜って」の境目には「-」付きの改行位置が残る。
 * これはコールバックからは消せないので、PDF テンプレートは text.tsx の Text（hyphenationPenalty で
 * その位置を改行候補から外す）を使い、1つの <Text> の中身もできるだけ1つの文字列にまとめる。
 */

/** これを超える長さの英数字の並びは、途中でも改行してよいことにする。 */
export const LONG_LATIN_RUN = 20;

/** 行頭に来てはいけない文字（JIS X 4051 の行頭禁則を簡略化）。 */
const NO_LINE_START = new Set(
  Array.from(
    ")]}）］｝〕〉》」』】〙〗〟’”｠»" + // 終わり括弧
      "‐゠–〜～" + // ハイフン・波ダッシュ
      "?!？！‼⁇⁈⁉" + // 区切り約物
      "・:;：；" + // 中点・コロン
      "。.、,，．｡､" + // 句読点
      "ヽヾゝゞ々〻ー" + // 繰返し記号・長音
      "…‥" + // 三点リーダー（UAX #14 の IN。直前でも分けない）
      "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ" + // 小書きかな
      "ｧｨｩｪｫｬｭｮｯｰﾞﾟ｣･" + // 半角かな
      "%％‰℃°′″¢￠" + // 後置記号
      "　", // 全角スペースは直前の文字に付けて行頭に残さない
  ),
);

/** 行末に来てはいけない文字（始め括弧・前置記号）。 */
const NO_LINE_END = new Set(Array.from("([{（［｛〔〈《「『【〘〖〝‘“｟«￥＄￡＃"));

/** 同じ文字どうしの間で分けない文字（「……」「――」）。 */
const INSEPARABLE = new Set(Array.from("—―…‥〳〴〵"));

/**
 * 1文字ずつ区切ってよい文字（和文扱い）。かな・漢字・CJK記号・全角英数・丸数字・㈱などの
 * 囲み文字、※○◎△□★ などの記号類。一般句読点のうち改行しない文字（U+2011 ノーブレークハイフン、
 * U+2028〜202F の行区切り・書字方向制御・狭いノーブレークスペース）は英数字側に残す。
 */
const CJK_LIKE =
  /[\p{Script=Han}\u2010\u2012-\u2027\u2030-\u205E\u2100-\u27BF\u2E80-\u2FDF\u3000-\u30FF\u3190-\u33FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/u;

/** 直前の文字と切り離さない文字（結合文字・異体字セレクタ・ゼロ幅接合子）。 */
const ZWJ = "\u200D";
const ATTACH_TO_PREVIOUS = /[\p{M}\u200D]/u;

function isCjkLike(ch: string): boolean {
  return CJK_LIKE.test(ch);
}

/** 語を「分けられない最小単位」に分ける。和文は1文字ずつ、英数字は連続した並びを1単位にする。 */
function toUnits(word: string): string[] {
  const units: string[] = [];
  let latin = "";
  let previousWasJoiner = false;
  const flushLatin = () => {
    if (!latin) return;
    if (Array.from(latin).length > LONG_LATIN_RUN) units.push(...Array.from(latin));
    else units.push(latin);
    latin = "";
  };
  for (const ch of word) {
    if ((ATTACH_TO_PREVIOUS.test(ch) || previousWasJoiner) && (latin || units.length > 0)) {
      if (latin) latin += ch;
      else units[units.length - 1] += ch;
      previousWasJoiner = ch === ZWJ;
      continue;
    }
    previousWasJoiner = ch === ZWJ;
    if (isCjkLike(ch)) {
      flushLatin();
      units.push(ch);
    } else {
      latin += ch;
    }
  }
  flushLatin();
  return units;
}

function firstChar(text: string): string {
  return Array.from(text)[0] ?? "";
}

function lastBaseChar(text: string): string {
  const chars = Array.from(text).filter((ch) => !ATTACH_TO_PREVIOUS.test(ch));
  return chars[chars.length - 1] ?? "";
}

/** before の直後・next の直前で改行してよいか。 */
function canBreakBetween(before: string, next: string): boolean {
  const last = lastBaseChar(before);
  const first = firstChar(next);
  if (NO_LINE_START.has(first) || NO_LINE_END.has(last)) return false;
  if (first === last && INSEPARABLE.has(first)) return false;
  return true;
}

/**
 * Font.registerHyphenationCallback に渡すコールバック。
 * 戻り値を連結すると必ず元の語に戻る（文字の追加・削除はしない）。
 */
export function splitForLineBreak(word: string): string[] {
  // 空白だけの語（半角・全角スペースの並び）は textkit が glue として扱うのでそのまま返す。
  if (word.trim() === "") return [word];
  const segments: string[] = [];
  for (const unit of toUnits(word)) {
    const previous = segments[segments.length - 1];
    if (previous !== undefined && !canBreakBetween(previous, unit)) segments[segments.length - 1] = previous + unit;
    else segments.push(unit);
  }
  const parts: string[] = [];
  segments.forEach((segment, index) => {
    if (index > 0) parts.push("");
    parts.push(segment);
  });
  const head = firstChar(segments[0]);
  if (isCjkLike(head) && !NO_LINE_START.has(head)) parts.unshift("");
  return parts;
}
