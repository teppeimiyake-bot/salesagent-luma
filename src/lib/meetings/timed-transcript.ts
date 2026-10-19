/**
 * T04: 区間の文字起こし（「[MM:SS] 話者N: 発話」）の時刻を読む・外す・区間のつなぎ目をそろえる純関数。
 *
 * 時刻は、モデルに区間の音声の先頭からの経過時間として書かせ、アプリの内部（区間の重なりの重複除去・
 * 書き漏れの確認）にだけ使う。利用者・議事録・BANT の根拠照合へ渡す本文からは必ず外す
 * （「[00:12] 話者1: 」の行は、根拠照合で話者「[00」の行として扱われてしまうため）。
 * 話者番号は書き換えない。区間どうしの番号は、直前の区間の末尾をモデルに渡すこと（previousSegmentTail）だけでそろえる
 * （重なりの数秒はモデルの話者の判定が最も不確かなところで、そこから区間全体の番号を置き換えると正しい番号まで入れ替わった）。
 * 時刻の無い行（従来の出力・形式の崩れ）はそのまま残し、時刻を使う処理は従来どおりの動作（連結だけ）に戻す。
 * DB・AI には依存しない。
 */

export type TimedLine = {
  /** 区間の音声の先頭からの秒。時刻が無い・読めない行は null。 */
  sec: number | null;
  /** 時刻を外した行（書き換えが無ければ、この形で本文に出す）。 */
  text: string;
  /** 行頭の話者名（「話者1」など）。無ければ null。 */
  speaker: string | null;
  /** 話者名と発話の間の区切り（「: 」など）。本文を置き換えるときに表記を保つ。 */
  separator: string;
  /** 話者名の後の発話（話者名が無ければ、時刻を外した行全体）。 */
  body: string;
};

/**
 * [MM:SS]・[H:MM:SS]（全角の括弧・コロン、小数秒、分は3桁まで）。「[00:12-00:15]」の範囲と、終わりの無い「[00:12〜]」も読み、
 * 範囲は始まりを使う。行頭の箇条書きの記号（- * ・ •）と、括弧を囲む太字の「**」も時刻と一緒に外す。
 */
const CLOCK = String.raw`(\d{1,3})[:：](\d{1,2})(?:[:：](\d{1,2}))?(?:[.．]\d+)?`;
const CLOCK_END = String.raw`\d{1,3}[:：]\d{1,2}(?:[:：]\d{1,2})?(?:[.．]\d+)?`;
const TIMESTAMP = new RegExp(String.raw`^\s*(?:[-*・•]\s*)?(?:\*\*)?[\[［]\s*${CLOCK}(?:\s*[-~〜～–]\s*(?:${CLOCK_END})?)?\s*[\]］](?:\*\*)?\s*`, "u");
/** issue-evidence.ts の labelledLine・long-transcript.ts の speakerLabel と同じ話者ラベルの判定。 */
const LABEL = /^([^:：。！？!?]{1,40}?)(\s*[:：]\s*)([\s\S]*)$/u;

/** 話者番号（「話者1」「話者１」「話者 1」）を比較用の形にする。話者N 以外の名前（営業・顧客など）は null。 */
function speakerKey(label: string | null): string | null {
  const key = labelKey(label);
  return /^話者\d+$/u.test(key) ? key : null;
}

function labelKey(label: string | null) {
  return label ? label.normalize("NFKC").replace(/\s+/gu, "") : "";
}

/**
 * 話者名に見えて、実は発話の中の時刻（「時間は14:00から」の「時間は14」）か。名前が数字で終わり、区切りに空白が無く、
 * 区切りの後が数字で始まる場合。「話者1：10時から」のような話者番号と、区切りに空白のある「話者1: 10時から」は話者名とする。
 */
function isClockInsideText(label: string, separator: string, rest: string) {
  return /[\d０-９]$/u.test(label) && /^[\d０-９]/u.test(rest) && !/\s/u.test(separator) && !speakerKey(label);
}

function clockSeconds(match: RegExpMatchArray): number | null {
  const [a, b, c] = [match[1], match[2], match[3]].map(value => value === undefined ? undefined : Number(value));
  const [hours, minutes, seconds] = c === undefined ? [0, a!, b!] : [a!, b!, c];
  if (seconds >= 60 || (c !== undefined && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** 1行を読む。行頭の時刻は必ず外す（読めない時刻でも本文には残さない）。 */
export function parseTimedLine(line: string): TimedLine {
  // 全角数字だけを半角にそろえて照合する（1文字ずつの置換なので、一致した長さは元の行でも同じ）。
  const ascii = line.replace(/[０-９]/gu, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  const stamp = ascii.match(TIMESTAMP);
  const text = stamp ? line.slice(stamp[0].length) : line;
  const labelled = text.trimStart().match(LABEL);
  const speaker = labelled && !/^[\d０-９\s]+$/u.test(labelled[1]) && !isClockInsideText(labelled[1], labelled[2], labelled[3])
    ? labelled[1].trim()
    : null;
  return {
    sec: stamp ? clockSeconds(stamp) : null,
    text,
    speaker: speaker || null,
    separator: speaker ? labelled![2] : "",
    body: speaker ? labelled![3] : text.trim(),
  };
}

export function parseTimedTranscript(text: string): TimedLine[] {
  return text.split("\n").map(parseTimedLine);
}

/** 日本語の文字（漢字・かな・長音・全角の句読点と括弧）。 */
const JAPANESE_CHAR = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆、。，．！？「」『』（）・…]`;
const JAPANESE_GAP = new RegExp(String.raw`(?<=${JAPANESE_CHAR}) (?=${JAPANESE_CHAR})`, "gu");

function isWordSpaced(line: string): boolean {
  const gaps = line.match(JAPANESE_GAP)?.length ?? 0;
  const spaces = line.match(/ /gu)?.length ?? 0;
  return gaps >= 3 && gaps * 2 >= spaces;
}

/**
 * モデルがまれに日本語を「撮影 の 開始 時期 は 未定 です 。」のように語ごとに空白で区切って出力する（2026-09-29 の実音声で
 * 1区間まるごと）。そのような行だけ、日本語の文字どうしの間の半角空白を取り除く。英数字の前後の空白は残す。
 * 日本語の文字の間の空白が3か所未満、または行の空白の半分未満の行（「株式会社 ルマ」など意図した空白）は変えない。
 */
export function collapseJapaneseWordSpacing(text: string): string {
  return text.split("\n").map(line => isWordSpaced(line) ? line.replace(JAPANESE_GAP, "") : line).join("\n");
}

const DIGIT = "[0-9０-９]";
/** 数字の直後の単位・助数詞・助詞の先頭（日付・時刻・金額・件数と「の・に・で・から・まで・ほど・以上」など）。 */
const AFTER_DIGIT = "[年月日時分秒円万億兆千百十割件名人社回個本台部枚歳代位点号階週冊通倍箇ヶヵカかつのにでまはをがもとやへよぐくほず以未程]";
/** 数字の直前のかな・漢字、読点・句点、開き括弧。全角の「，」「．」は数字の区切りになり得るので含めない。 */
const BEFORE_DIGIT = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆、。「『（]`;
const DIGIT_GAP = new RegExp(String.raw`(?<=${DIGIT}) +(?=${AFTER_DIGIT})|(?<=${BEFORE_DIGIT}) +(?=${DIGIT})`, "gu");

/**
 * Google Meet の文字起こしは数字と日本語の間に半角空白を入れ（「10 月 10 日」「来年 4 月」「250 万円」）、発言がまるごと
 * 語ごとに区切られることもある（2026-09-30 の実 Meet）。日付・金額の判定が原文どおりに一致するよう、数字とその単位・助詞、
 * かな漢字と数字の間の空白を取り除く。単位の無い数字の後ろ（「301 担当」）、数字どうし、英字や記号、全角の「，」「．」の
 * 前後の空白は残す。語ごとに区切られた発言は collapseJapaneseWordSpacing と同じ規則で詰めるが、その判定は元の行で行う
 * （数字の空白を先に消すと空白の数が減り、列挙などの意図した空白まで詰めてしまうため）。
 */
export function normalizeMeetTranscriptSpacing(text: string): string {
  return text.split("\n").map(line => {
    const tight = line.replace(DIGIT_GAP, "");
    return isWordSpaced(line) ? tight.replace(JAPANESE_GAP, "") : tight;
  }).join("\n");
}

/** 利用者・後段へ渡す形。行頭の時刻だけを外し、ほかの文字・空行・行の並びは変えない。 */
export function stripTimestamps(text: string): string {
  return parseTimedTranscript(text).map(line => line.text).join("\n");
}

function spoken(lines: TimedLine[]) {
  return lines.filter(line => line.text.trim());
}

/** 発話のある行の半数以上に時刻があれば、時刻付きの出力として扱う（一部の行だけの時刻は当てにしない）。 */
export function isTimedTranscript(lines: TimedLine[]): boolean {
  const withText = spoken(lines);
  return withText.length > 0 && withText.filter(line => line.sec !== null).length * 2 >= withText.length;
}

/**
 * 時刻付きの出力なら、最も遅い時刻（秒）。時刻付きでなければ null。maxSec より大きい時刻（区間の長さを超える
 * 書き誤り）は数えない。数えられる時刻が無ければ null。
 */
export function lastTimestampSec(text: string, maxSec = Infinity): number | null {
  const lines = parseTimedTranscript(text);
  if (!isTimedTranscript(lines)) return null;
  const times = lines.flatMap(line => line.sec === null || line.sec > maxSec ? [] : [line.sec]);
  return times.length ? Math.max(...times) : null;
}

/** 発話の文字数（時刻・話者名・空白・句読点を除く）。書き漏れの再試行の結果を比べるのに使う。 */
export function spokenTextLength(text: string): number {
  return parseTimedTranscript(text).reduce((total, line) => total + normalizeForMatch(line.body).length, 0);
}

/** 出力が「（聞き取れませんでした）」だけか（無音の区間）。 */
export function isNoSpeechTranscript(text: string): boolean {
  const lines = spoken(parseTimedTranscript(text));
  return lines.length > 0 && lines.every(line => normalizeForMatch(line.body) === "聞き取れませんでした");
}

/** 照合用の正規化（NFKC、空白・句読点・記号を除く）。 */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
}

/** これより長い行どうしは類似度を計算しない（一致・包含だけで判定する）。 */
const SIMILARITY_MAX_CHARS = 200;
export const LINE_SIMILARITY_THRESHOLD = 0.8;
/** 包含で一致とみなす短い方の最小の長さ（正規化後の文字数）。 */
export const LINE_CONTAIN_MIN_CHARS = 6;
/** 途切れた行とみなして、末尾の何文字までの食い違いを許すか。 */
const TRUNCATED_TAIL_CHARS = 3;
/** 短い行（「はい」など）は、同じ文字で、録音全体での時刻がこの秒数以内のときだけ同じ発話とみなす。 */
const SHORT_LINE_TIME_TOLERANCE_SEC = 3;

function longestBlock(a: string[], alo: number, ahi: number, b: string[], blo: number, bhi: number): [number, number, number] {
  let best: [number, number, number] = [alo, blo, 0];
  let previous = new Array<number>(bhi - blo + 1).fill(0);
  for (let i = alo; i < ahi; i++) {
    const current = new Array<number>(bhi - blo + 1).fill(0);
    for (let j = blo; j < bhi; j++) {
      if (a[i] !== b[j]) continue;
      const size = previous[j - blo] + 1;
      current[j - blo + 1] = size;
      if (size > best[2]) best = [i - size + 1, j - size + 1, size];
    }
    previous = current;
  }
  return best;
}

/**
 * difflib.SequenceMatcher の ratio と同じ考え方（最長の共通部分を取り、左右で繰り返す）の類似度。
 * 入力は短い1行なので、長さに上限を設けて素直に計算する。
 */
export function lineSimilarity(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (!left.length && !right.length) return 1;
  let matched = 0;
  const stack: Array<[number, number, number, number]> = [[0, left.length, 0, right.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    if (alo >= ahi || blo >= bhi) continue;
    const [i, j, size] = longestBlock(left, alo, ahi, right, blo, bhi);
    if (!size) continue;
    matched += size;
    stack.push([alo, i, blo, j], [i + size, ahi, j + size, bhi]);
  }
  return (2 * matched) / (left.length + right.length);
}

type MatchKind = "same" | "extends";

/**
 * 前の区間の行 prev と次の区間の行 next（どちらも正規化済み）が同じ発話か。
 * "extends" は、次の区間の行の方が長く、前の区間の行を含む・前の区間の行が途切れている（先頭が一致する）・
 * 類似度だけで一致し、次の区間の行が TRUNCATED_TAIL_CHARS より長い場合。
 */
export function matchLines(prev: string, next: string, options: { prevIsLast?: boolean; timeGapSec?: number | null } = {}): MatchKind | null {
  if (!prev || !next) return null;
  const shorter = Math.min(prev.length, next.length);
  if (prev === next) {
    if (shorter >= LINE_CONTAIN_MIN_CHARS) return "same";
    const gap = options.timeGapSec;
    return gap !== undefined && gap !== null && Math.abs(gap) <= SHORT_LINE_TIME_TOLERANCE_SEC ? "same" : null;
  }
  if (shorter >= LINE_CONTAIN_MIN_CHARS) {
    if (next.length > prev.length && next.includes(prev)) return "extends";
    if (prev.includes(next)) return "same";
  }
  // 前の区間の最後の行は、区間の終わりで語の途中から途切れる（「…立ちい」→「…立ち入りの…」）。
  if (options.prevIsLast && next.length > prev.length) {
    for (let cut = 1; cut <= TRUNCATED_TAIL_CHARS; cut++) {
      const head = prev.slice(0, prev.length - cut);
      if (head.length >= LINE_CONTAIN_MIN_CHARS && next.startsWith(head)) return "extends";
    }
  }
  if (prev.length > SIMILARITY_MAX_CHARS || next.length > SIMILARITY_MAX_CHARS) return null;
  // 数字（金額・日付・人数）だけが違う行は、似ていても別の発話として残す（「80万円」と「90万円」を重複にしない）。
  if (prev.replace(/\D/gu, "") !== next.replace(/\D/gu, "")) return null;
  // 類似度の上限（2×短い方÷合計）が閾値に届かない組は計算しない。
  if ((2 * shorter) / (prev.length + next.length) < LINE_SIMILARITY_THRESHOLD) return null;
  if (lineSimilarity(prev, next) < LINE_SIMILARITY_THRESHOLD) return null;
  // 似ているだけで次の区間の行の方が明らかに長ければ、次の区間だけが聞き取った続きを含みうる。長い方に置き換える。
  return next.length - prev.length > TRUNCATED_TAIL_CHARS ? "extends" : "same";
}

export type TimedSegmentInput = { text?: string; startSec: number; endSec: number };

type SegmentState = { lines: TimedLine[]; timed: boolean; startSec: number; endSec: number };

/** 重なりの前後で見る秒数の余裕と、見る行数の上限。 */
const BOUNDARY_MARGIN_SEC = 3;
const BOUNDARY_MAX_LINES = 8;
/**
 * 次の区間の最初の発話がこの秒数までに始まり、先頭の数文字（語の途中から聞こえた音。「だいたい40分ほどで」が
 * 「第40分ほどで」になる）を除くと前の区間の行に含まれるなら、前の区間の発話の後半（断片）とみなす。
 */
export const LEADING_FRAGMENT_MAX_SEC = 2;
const LEADING_FRAGMENT_SKIP_CHARS = 3;

/** どちらも「話者N」で番号が違う（別の人の発話として両方を残す）。 */
function differentSpeakers(a: TimedLine, b: TimedLine) {
  const left = speakerKey(a.speaker);
  const right = speakerKey(b.speaker);
  return !!left && !!right && left !== right;
}

function withBody(line: TimedLine, body: string): TimedLine {
  return { ...line, body, text: line.speaker ? `${line.speaker}${line.separator}${body}` : body };
}

/** 時刻の無い行は、直前の時刻の行と同じ位置にあるとみなす（区間の先頭の時刻の無い行は0秒）。 */
function effectiveSeconds(lines: TimedLine[]) {
  let current = 0;
  return lines.map(line => (current = line.sec ?? current));
}

/**
 * 次の区間の先頭の行（正規化済み）が、前の区間のどの行の断片か。先頭から最大 LEADING_FRAGMENT_SKIP_CHARS 文字を除いた
 * 残り（LINE_CONTAIN_MIN_CHARS 文字以上）を含む最初の行の位置。無ければ -1。
 */
function leadingFragmentOf(text: string, prevTexts: string[]): { index: number; continues: boolean } | null {
  const chars = Array.from(text);
  for (let skip = 0; skip <= LEADING_FRAGMENT_SKIP_CHARS && chars.length - skip >= LINE_CONTAIN_MIN_CHARS; skip++) {
    const rest = chars.slice(skip).join("");
    const found = prevTexts.findIndex(prevText => prevText.includes(rest));
    if (found >= 0) return { index: found, continues: !prevTexts[found].endsWith(rest) };
  }
  return null;
}

/**
 * 前の区間（処理済み）と次の区間の境界を処理し、次の区間の行（重複を除いたもの）を返す。話者名は書き換えない。
 * 次の区間の行を重複として除くときは前の区間の行（と話者名）を残し、前の区間の行が途切れている・短い場合は
 * 前の区間の行の本文だけを長い方に置き換える（話者名は前の区間のまま）。
 */
function alignBoundary(prev: SegmentState, next: SegmentState): TimedLine[] {
  const overlapSec = Math.max(0, prev.endSec - next.startSec);
  const windowSec = overlapSec + BOUNDARY_MARGIN_SEC;
  const prevDuration = prev.endSec - prev.startSec;
  const prevSeconds = effectiveSeconds(prev.lines);
  const nextSeconds = effectiveSeconds(next.lines);
  const prevSpoken = prev.lines.map((line, index) => index).filter(index => normalizeForMatch(prev.lines[index].body));
  const nextSpoken = next.lines.map((line, index) => index).filter(index => normalizeForMatch(next.lines[index].body));
  const lastPrev = prevSpoken.at(-1);
  // 重なりより前に始まり、重なりの中まで続く長い行も比べる（窓の直前の行を1行含める）。
  const firstInWindow = prevSpoken.findIndex(index => prevSeconds[index] >= prevDuration - windowSec);
  const windowStart = prevDuration - windowSec;
  const spanStart = firstInWindow < 0 ? prevSpoken.length - 1 : firstInWindow - 1;
  // 窓の直前の行は、長さから見て窓まで続きうる（4文字/秒で話しても窓に届く）場合だけ含める。
  const spans = spanStart >= 0 && prevSeconds[prevSpoken[spanStart]] + Array.from(normalizeForMatch(prev.lines[prevSpoken[spanStart]].body)).length / 4 >= windowStart;
  const prevWindow = (firstInWindow < 0 ? (spans ? prevSpoken.slice(-1) : []) : prevSpoken.slice(spans ? spanStart : firstInWindow)).slice(-BOUNDARY_MAX_LINES);
  const prevTexts = prevWindow.map(index => normalizeForMatch(prev.lines[index].body));
  const nextWindow = nextSpoken.filter(index => nextSeconds[index] <= windowSec).slice(0, BOUNDARY_MAX_LINES);
  const drop = new Set<number>();

  // 順序を保って対応付ける（次の区間の行ごとに、前の対応より後ろの前の区間の行から探す）。
  // 前の区間の1行を次の区間が2行に分けて書いた場合は、どちらもその1行に含まれるので、同じ行に続けて対応させる（reuse）。
  let from = 0;
  let reuse = -1;
  // 次の区間の最初の行が、区間の始まりで途中から聞こえた前の区間の発話の断片なら、話者名に関わらず除く
  // （途中から聞こえた発話の話者の判定は当てにならない）。
  const head = nextSpoken[0];
  if (head !== undefined && nextSeconds[head] <= LEADING_FRAGMENT_MAX_SEC) {
    const found = leadingFragmentOf(normalizeForMatch(next.lines[head].body), prevTexts);
    if (found) {
      drop.add(head);
      from = found.continues ? found.index : found.index + 1;
      reuse = found.continues ? found.index : -1;
    }
  }

  const pairs: Array<{ prevIndex: number; nextIndex: number; kind: MatchKind }> = [];
  for (const nextIndex of nextWindow) {
    if (drop.has(nextIndex)) continue;
    const nextLine = next.lines[nextIndex];
    const nextText = normalizeForMatch(nextLine.body);
    const nextAt = next.startSec + nextSeconds[nextIndex];
    for (let k = from; k < prevWindow.length; k++) {
      const prevIndex = prevWindow[k];
      const prevLine = prev.lines[prevIndex];
      // どちらも「話者N」で番号が違えば、同じ文でも別の人の発話（相づち・復唱）として両方を残す。
      if (differentSpeakers(prevLine, nextLine)) continue;
      // 同じ前の区間の行に続けて対応させるのは、次の区間の行がその行の話している間（前の区間の次の行が始まる前、
      // 次の行が無ければ前の区間の終わりの少し後まで）に始まる場合だけ。後の別の発話を、長い行に含まれるだけで除かない。
      if (k === reuse) {
        const following = k + 1 < prevWindow.length ? prev.startSec + prevSeconds[prevWindow[k + 1]] : prev.endSec + BOUNDARY_MARGIN_SEC;
        if (nextAt >= following || !prevTexts[k].includes(nextText)) continue;
      }
      const timeGapSec = prevLine.sec !== null && nextLine.sec !== null
        ? prev.startSec + prevLine.sec - (next.startSec + nextLine.sec)
        : null;
      const kind = matchLines(prevTexts[k], nextText, { prevIsLast: prevIndex === lastPrev, timeGapSec });
      if (!kind) continue;
      pairs.push({ prevIndex, nextIndex, kind });
      from = kind === "same" && nextText.length < prevTexts[k].length && prevTexts[k].includes(nextText) && !prevTexts[k].endsWith(nextText) ? k : k + 1;
      reuse = from === k ? k : -1;
      break;
    }
  }

  const absorbed = new Set<number>();
  for (const { prevIndex, nextIndex, kind } of pairs) {
    if (absorbed.has(prevIndex)) {
      // 前の区間の行は、前の組の置き換えで長い行に含まれて除かれた。同じ内容の行だけを除き、続きを含む行は残す。
      if (kind === "same") drop.add(nextIndex);
      continue;
    }
    if (kind === "extends") {
      // 前の区間の行の「話者名」が、実は発話の一部（「条件は二つです：…」を話者名と読んだもの）なら、書き換えずに両方を残す。
      const prevLabel = prev.lines[prevIndex].speaker;
      if (prevLabel && !speakerKey(prevLabel) && normalizeForMatch(next.lines[nextIndex].body).startsWith(normalizeForMatch(prevLabel))) continue;
      // 前の区間の行が区間の終わりで途切れている、または次の区間が続きまで1行に書いた。話者は前の区間のまま、長い発話に置き換える。
      const longer = normalizeForMatch(next.lines[nextIndex].body);
      prev.lines[prevIndex] = withBody(prev.lines[prevIndex], next.lines[nextIndex].body);
      // 前の区間がその続きを別の行に書いていれば（長い行に含まれる直後の行）、二重にならないよう除く。
      for (let j = prevIndex + 1; j < prev.lines.length; j++) {
        const following = normalizeForMatch(prev.lines[j].body);
        if (!following) continue;
        const sameSpeaker = labelKey(prev.lines[j].speaker) === labelKey(prev.lines[prevIndex].speaker);
        if (!sameSpeaker || following.length < LINE_CONTAIN_MIN_CHARS || !longer.includes(following)) break;
        absorbed.add(j);
      }
    }
    drop.add(nextIndex);
  }
  if (absorbed.size) prev.lines = prev.lines.filter((line, index) => !absorbed.has(index));
  return next.lines.filter((line, index) => !drop.has(index));
}

/**
 * 区間の本文を順に連結する（区間の間は空行1行）。時刻は必ず外す。
 * 前後の区間がどちらも時刻付きなら、境界の重なりの行を照合して重複した行を除く（話者名は書き換えない）。
 * どちらかに時刻が無ければ、その境界は従来どおり連結だけにする。
 */
export function joinTimedSegments(segments: TimedSegmentInput[]): string {
  const states: SegmentState[] = [];
  let previous: SegmentState | null = null;
  for (const segment of segments) {
    const text = segment.text?.trim() ?? "";
    if (!text) {
      previous = null;
      continue;
    }
    const lines = parseTimedTranscript(text);
    const state: SegmentState = { lines, timed: isTimedTranscript(lines), startSec: segment.startSec, endSec: segment.endSec };
    if (previous?.timed && state.timed) state.lines = alignBoundary(previous, state);
    states.push(state);
    previous = state;
  }
  return states.map(state => state.lines.map(line => line.text).join("\n").trim()).filter(Boolean).join("\n\n");
}
