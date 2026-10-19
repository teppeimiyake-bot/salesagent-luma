import { BANT_UNKNOWN_VALUES } from "./bant-definitions";
import { findBantWithdrawal, type BantWithdrawal } from "./bant-withdrawal";

export type TimelineSourceTurn = { id: number; text: string };

/**
 * 発話の先頭に来る明示的な話者ラベル（話者N・営業・顧客など）。人名や項目名（「理由：」）は含めない。
 * ラベルの直前の時刻（「[00:05] 」「［0:05］」「00:05 」）はラベルと一緒に扱い、時刻だけの行を作らない。
 */
const RUN_ON_SPEAKER_LABEL = /(?:(?:[\[［][ \t]*[0-9０-９]{1,3}[:：][0-9０-９]{1,2}(?:[:：][0-9０-９]{1,2})?(?:[.．][0-9０-９]+)?[ \t]*[\]］]|[0-9０-９]{1,3}[:：][0-9０-９]{2}(?:[:：][0-9０-９]{2})?)[ \t\u3000]*)?(?:話者[ \t]*[0-9０-９]{1,2}|speaker[ \t]*[0-9０-９]{1,2}|顧客|先方|お客様|営業(?:担当者?)?|当社|弊社)(?:[（(][^（）()\r\n:：]{1,20}[）)])?[ \t]*[:：]/giu;

/**
 * T04: 区間に分けない短い録音で、モデルが改行せずに全発話を1行で返した文字起こし（既に1行で保存された記録を含む）を、
 * 行の途中にある明示的な話者ラベルの位置でだけ行に分ける。根拠照合は1行を1発話として扱い、話者ラベルが2つ以上ある行は
 * 話者が混ざった行として採らないため、1行のままだと議事録の課題・提案・対応予定や BANT の根拠がすべて落ちる。
 * - 行が話者ラベル（前の時刻を含む）で始まる場合だけ分ける。ラベルの無い先頭部分は、営業・顧客のどちらの発話か、
 *   前の行の続きかが分からないため、分けて単独の発言として採られないよう、その行は分けずに従来どおり不採用にする。
 * - ラベルの直前が句点などの文末記号か空白のときだけ分け、ラベルの間の空白だけを外す（発話の文字は変えない）。
 * - 話者ラベルの無い行や、文の途中に続けて書かれたラベルは分けない（話者を推測して根拠を通さない）。
 * 既に1行1発話の文字起こしは変わらない（何度適用しても同じ）。
 */
export function splitRunOnSpeakerTurns(transcript: string): string {
  return transcript.split("\n").map((line) => {
    const matches = [...line.matchAll(RUN_ON_SPEAKER_LABEL)];
    if (!matches.length || line.slice(0, matches[0].index).trim()) return line;
    const pieces: string[] = [];
    let start = 0;
    for (const match of matches.slice(1)) {
      const before = line.slice(start, match.index);
      const kept = before.replace(/[ \t\u3000]+$/u, "");
      if (kept.length === before.length && !/[。．！？!?」』）)…]$/u.test(kept)) continue;
      pieces.push(kept);
      start = match.index;
    }
    pieces.push(line.slice(start));
    return pieces.join("\n");
  }).join("\n");
}

/** Stable, one-based IDs for nonblank source lines; never rewrite their text. */
export function timelineSourceTurns(transcript: string): TimelineSourceTurn[] {
  return transcript.split(/\r?\n/u).filter((line) => line.trim()).map((text, index) => ({ id: index + 1, text }));
}

/** Remove only generated trailing line-ID citations, never source business IDs. */
export function stripGeneratedSourceReference(value: string, transcript: string): string {
  const reference = /[（(][ \t]*ids?[ \t]*[:：][ \t]*(\d+(?:[ \t]*[,、][ \t]*\d+)*)[ \t]*[）)]/giu;
  const key = (ids: string) => [...new Set(ids.split(/[,、]/u).map(Number))].sort((a, b) => a - b).join(",");
  const sourceReferences = new Set([...transcript.normalize("NFKC").matchAll(reference)].map((match) => key(match[1])));
  const sourceCount = timelineSourceTurns(transcript).length;
  const suffix = /[ \t]*[（(][ \t]*ids?[ \t]*[:：][ \t]*(\d+(?:[ \t]*[,、][ \t]*\d+)*)[ \t]*[）)][ \t]*$/iu;
  let result = value;
  for (;;) {
    const match = result.match(suffix);
    if (!match || sourceReferences.has(key(match[1]))) return result;
    const ids = match[1].split(/[,、]/u).map(Number);
    if (!ids.every((id) => Number.isSafeInteger(id) && id >= 1 && id <= sourceCount)) return result;
    result = result.slice(0, match.index);
  }
}

const adoptionLifecycle = /導入|本稼働|本番稼働|運用開始|利用開始|稼働開始|サービス開始/u;
const videoLifecycle = /(?:動画|映像)(?:の|を)?(?:公開|納品)|(?:動画|映像)(?:は|を)[^。！？!?]{0,24}(?:公開|納品)/u;
const lifecycle = new RegExp(`${adoptionLifecycle.source}|${videoLifecycle.source}`, "u");
const timingTopic = /導入(?:の)?(?:時期|日程|予定|希望時期)|(?:本稼働|本番稼働|運用開始|利用開始|稼働開始|サービス開始)(?:の)?(?:時期|日程|予定)?|(?:動画|映像)(?:の|を)?(?:公開|納品)(?:の)?(?:時期|日程|予定)?/u;
const timeExpression = /(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|[\d０-９一二三四五六七八九十]+[ \t\u3000]*(?:年|年度|月|日|週間|か月|ヶ月|カ月|ケ月|週|四半期)|(?:来|再来|今|翌|次|本)(?:年|年度|月|週|期)|来春|来夏|来秋|来冬|年内|年度内|月内|上期|下期|年度末|年末|春|夏|秋|冬|今日|明日|即日|即時)/u;
const uncertainty = /未確認|未確定|未定|不明|分から|分かりません|わから|わかりません|決めてい(?:ない|ません)|決まってい(?:ない|ません)|検討してい(?:ない|ません)|検討(?:の)?段階では(?:ない|ありません)|検討に(?:は)?(?:入っていない|入っていません|至っていない|至っていません)/u;
const unrelatedSchedule = /面談|打ち合わせ|打合せ|会議|商談|見積|資料|送付|提出|予算|承認|決裁|稟議|撮影/u;
const questionEnding = /[?？]|(?:です|ます|ません|でしょう|だろう|なの|なのです|よろしい|可能です|可能でしょう)か[。！!]?\s*$/u;
const speakerMarker = /(?:顧客|先方|お客様|営業(?:担当者?)?|当社|弊社|担当者?|話者\s*\d+|speaker\s*\d+)\s*[:：]/giu;
const salesSpeaker = /^\s*(?:営業(?:担当者?)?|当社|弊社|売り手|セールス)\s*[:：]/u;

function utteranceBody(text: string, allowSeller = false): string | null {
  if (!allowSeller && salesSpeaker.test(text)) return null;
  // A mixed turn can contain a sales question plus a customer's refusal. Do
  // not infer the boundary or turn that exchange into a customer timeline.
  if ((text.match(speakerMarker) ?? []).length > 1) return null;
  const leadingSpeaker = text.match(/^\s*([^:：\r\n]{1,40})\s*[:：]/u);
  const remainder = leadingSpeaker ? text.slice(leadingSpeaker[0].length) : text;
  // A manual line may use a field label rather than a speaker label.
  const body = leadingSpeaker && !lifecycle.test(leadingSpeaker[1]) ? remainder : text;
  // Additional named turns are ambiguous; a clock time such as 10:00 is not
  // a speaker marker. Field-label colons may also be rejected conservatively.
  if (/(?:^|[\s。！？!?])[^\s:：\d０-９]{1,20}\s*[:：]/u.test(remainder)) return null;
  return body;
}

/** Only an explicit, unambiguous label can join adjacent source lines. */
function contextSpeaker(text: string): string | null {
  if (utteranceBody(text) === null) return null;
  const label = text.match(/^\s*([^:：\r\n]{1,40})\s*[:：]/u)?.[1].trim();
  return label && !lifecycle.test(label) ? label : null;
}

function directlyLinkedTime(clause: string): boolean {
  const lifecyclePart = "(?:導入(?:の)?(?:時期|日程|予定)?|本稼働|本番稼働|運用開始|利用開始|稼働開始|サービス開始|(?:採用)?(?:動画|映像)(?:の|を)?(?:公開|納品))";
  const timePart = timeExpression.source;
  return new RegExp(`${lifecyclePart}(?:は|を|が|に|の|するなら|するとしても|する場合は|予定は|希望は|時期は|予定時期は|希望時期は|開始は|開始予定は|開始希望は|開始時期は|開始するなら|開始する場合は|については|としては|も|で|：|:|\\s){0,5}${timePart}`, "u").test(clause) ||
    new RegExp(`${timePart}(?:(?:中|末|上旬|中旬|下旬|以降|以前|以後|より前|まで|から|ごろ|頃|に|の|を|は|で|\\s)){0,5}${lifecyclePart}`, "u").test(clause);
}

type EvidenceKind = "concrete" | "unknown" | null;

/**
 * T04: 顧客が商材の利用開始・公開・納品の期限を述べた発言（「4月の新入研修に間に合えば十分です」
 * 「来年5月の採用サイトの刷新に合わせて公開できれば十分です」「4月までに使いたい」）。導入・公開などの語が無くても
 * 時期の根拠として認める。期限の語と時期が同じ節にあり、疑問形・仮定（もし・仮に）・撤回や以前の発言の引用・
 * 未定の表明・打ち合わせや見積などの別の予定・資料や他社の話を含む文は通さない。営業の発言は utteranceBody で除く。
 */
const usageDeadline = /間に合(?:えば|えれば)(?:十分|大丈夫|問題(?:ありません|ない)|よい|良い|いい)|間に合わせ(?:たい|てほしい|て欲しい|てください|てもらいたい)|間に合う(?:ように|よう)(?:したい|お願い)|に合わせて(?:公開|納品|導入|使い始め|利用|運用)|までに(?:使いたい|使い始めたい|利用したい|公開したい|導入したい|納品(?:してほしい|して欲しい|をお願い|してください))|から(?:使いたい|使い始めたい|利用したい|利用を始めたい)/u;
/** T06: 撤回・取り下げを述べた文。時期の根拠にも、根拠の前後の文脈にもしない。 */
const withdrawalStatement = /撤回|取り下げ|取り消|白紙/u;
const retractedOrReported = new RegExp(`${withdrawalStatement.source}|と(?:言い|お話しし|申し|お伝えし|話し)ました(?:が|けど|けれど)`, "u");
const deadlineOtherSubject = /資料|見積|書類|書面|パンフレット|他社|別会社|別案件|別件/u;

function usageDeadlineSentence(sentence: string): boolean {
  if (questionEnding.test(sentence) || retractedOrReported.test(sentence) || /もし|仮に/u.test(sentence) ||
    uncertainty.test(sentence) || unrelatedSchedule.test(sentence) || deadlineOtherSubject.test(sentence)) return false;
  return sentence.split(/[、,；;]/u).some((clause) => usageDeadline.test(clause) && timeExpression.test(clause));
}

const explicitCustomer = /^\s*(?:顧客|先方|お客様)\s*[:：]/u;
const videoTopic = /(?:動画|映像)(?:の|を)?(?:導入|制作|発注|公開|納品)/u;
const bareMilestone = /納品|公開/u;
const otherVideoContext = /資料|見積|書類|書面|パンフレット|他社|別会社|別案件|別の案件|別の動画|別の映像/u;
const quotedOrHypothetical = /[「」『』“”"]|もし|仮に|の場合|なら|れば/u;
const fullDate = /(?:[0-9０-９]{4}年)?[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{4}[-/][0-9０-９]{1,2}[-/][0-9０-９]{1,2}/gu;
const milestoneThenDate = new RegExp(`^(?:(?:採用)?(?:動画|映像)(?:の|を)?|正式な|採用サイトでの)?(?:納品|公開)(?:日|時期|日程|予定)?(?:は|を|が|で)(${fullDate.source})`, "u");
const dateThenMilestone = new RegExp(`^(?:(?:当社|弊社|御社)が掲載作業を行う)?(${fullDate.source})(?:の|に)?(?:(?:採用)?(?:動画|映像)(?:の|を)?)?(?:納品|公開)`, "u");
const videoTopicContinuation = /^(?:はい[。．]|(?:私|当社|弊社)の(?:決裁|承認)で(?:確定|合意)|追加の社内承認は(?:不要|必要ありません)|完成データを(?:御社|当社|弊社)(?:に|へ)納品)/u;

/** Dates belong to the milestone's own clause, not merely the same turn. */
function scopedVideoDates(body: string, initialTopic: boolean): string[] {
  let topic = initialTopic;
  const dates: string[] = [];
  for (const part of body.match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
    const sentence = part.trim();
    if (otherVideoContext.test(sentence) || quotedOrHypothetical.test(sentence)
      || questionEnding.test(sentence)) { topic = false; continue; }
    const explicitTopic = videoTopic.test(sentence);
    if (explicitTopic) {
      topic = !uncertainty.test(sentence) && !/しません|しない|合意していません|発注していません/u.test(sentence);
    }
    const linkedDates = !unrelatedSchedule.test(sentence) ? sentence.split(/[、,；;]/u).flatMap(clause => {
      const match = clause.trim().match(milestoneThenDate) ?? clause.trim().match(dateThenMilestone);
      return match ? [match[1]] : [];
    }) : [];
    if (topic && linkedDates.length) dates.push(...linkedDates);
    // Only explicit video references, milestone clauses and narrow same-topic
    // approval/delivery continuations carry a topic across sentence boundaries.
    if (!explicitTopic && !linkedDates.length && !videoTopicContinuation.test(sentence)) topic = false;
  }
  return dates;
}

/** Resolve omitted "video" only within an explicit customer topic, or a direct
 * confirmation of the immediately preceding seller's video milestone. Keep the
 * seller as separately labelled context, never as a customer-authored statement.
 */
function contextualVideoMilestone(text: string, previousText?: string): "same_turn" | "previous_seller" | null {
  if (!explicitCustomer.test(text)) return null;
  const body = utteranceBody(text);
  if (body === null) return null;
  if (scopedVideoDates(body, false).length) return "same_turn";
  if (!previousText || !salesSpeaker.test(previousText) || !/^\s*はい[。．、,]/u.test(body)
    || !/(?:日程|納品|公開)[^。！？!?]{0,100}(?:確定|合意)(?:します|です)/u.test(body)
    || !bareMilestone.test(body)) return null;
  const previousBody = utteranceBody(previousText, true);
  if (previousBody === null || !videoLifecycle.test(previousBody) || !timeExpression.test(previousBody)
    || otherVideoContext.test(previousBody) || quotedOrHypothetical.test(previousBody)
    || questionEnding.test(previousBody) || uncertainty.test(previousBody)
    || /候補|しません|しない|お引き受けできません/u.test(previousBody)) return null;
  // A date-only "yes" must match dates in eligible video clauses, not dates
  // attached to another product anywhere else in the seller's turn.
  const dates = scopedVideoDates(body, true);
  const offeredDates = new Set(scopedVideoDates(previousBody, false).map(date => date.normalize("NFKC")));
  if (!dates.length || !dates.every(date => offeredDates.has(date.normalize("NFKC")))) return null;
  return "previous_seller";
}

/**
 * Limited Japanese source selection, not a general language entailment test.
 * IDs only select exact utterances; no generated interpretation is rendered.
 * Indirect references, unfamiliar date forms, mixed speakers and ambiguous
 * relations fail closed. Selection can still contain irrelevant source text.
 */
function evidenceKind(text: string): EvidenceKind {
  const body = utteranceBody(text);
  if (body === null) return null;
  let hasUnknown = false;
  for (const sentence of body.match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
    if (usageDeadlineSentence(sentence)) return "concrete";
    if (questionEnding.test(sentence) || withdrawalStatement.test(sentence) || !lifecycle.test(sentence)) continue;
    // Publication/delivery is a relevant milestone for the actual video, not
    // its proposal documents. Unknown document/product relations fail closed.
    if (!adoptionLifecycle.test(sentence) && /資料|見積|書類|書面|パンフレット/u.test(sentence)) continue;
    if (timingTopic.test(sentence) && uncertainty.test(sentence)) hasUnknown = true;
    if (!timeExpression.test(sentence)) continue;
    // Past implementation is not a future adoption target. An explicit new
    // target in another sentence remains eligible.
    if (/昨年|去年|先月|当時|導入(?:済み?|した(?!い)|しました|しています)/u.test(sentence) &&
      !/希望|予定|目標|合意|確定|するなら|するとしても/u.test(sentence)) continue;
    if (!unrelatedSchedule.test(sentence) ||
      sentence.split(/[、,；;]/u).some((clause) => lifecycle.test(clause) && timeExpression.test(clause) &&
        (!unrelatedSchedule.test(clause) || directlyLinkedTime(clause)))) return "concrete";
  }
  return hasUnknown ? "unknown" : null;
}

/**
 * T06: 引用のうち、それ単独で具体的な時期の根拠になる行（撤回・疑問・文脈だけの行を除く）。
 * 商談 BANT の引用が撤回の行だけになっていないかの確認に使う。
 */
export function timelineEvidenceLines(quote: string): string[] {
  return quote.split(/\r?\n/u).filter((line) => line.trim() && evidenceKind(line) === "concrete");
}

export function groundTimeline(transcript: string, sourceIds: unknown): {
  value: string;
  sourceIds: number[];
  sourceQuotes: string[];
  /** Lines retained as surrounding context rather than independent evidence. */
  contextSourceIds: number[];
  rejectedSourceIds: unknown[];
  withdrawal?: BantWithdrawal;
} {
  const turns = timelineSourceTurns(transcript);
  const physicalLines = transcript.split(/\r?\n/u).map((text, index) => ({ text, index })).filter(({ text }) => text.trim());
  const requested = Array.isArray(sourceIds) ? sourceIds : [];
  const withdrawn = findBantWithdrawal(transcript, "timeline");
  if (withdrawn) return { value: withdrawn.value, sourceIds: [], sourceQuotes: [], contextSourceIds: [],
    rejectedSourceIds: requested, withdrawal: withdrawn };
  const rejectedSourceIds: unknown[] = !Array.isArray(sourceIds) && sourceIds !== undefined ? [sourceIds] : [];
  const accepted = new Map<number, { text: string; kind: Exclude<EvidenceKind, null> }>();
  const supportingTurns = new Set<number>();
  for (const id of requested) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > turns.length) {
      rejectedSourceIds.push(id);
      continue;
    }
    if (accepted.has(id)) continue;
    const source = turns[id - 1];
    const directKind = evidenceKind(source.text);
    const context = directKind === null ? contextualVideoMilestone(source.text, turns[id - 2]?.text) : null;
    const kind = directKind ?? (context ? "concrete" : null);
    if (kind === null) rejectedSourceIds.push(id);
    else {
      accepted.set(id, { text: source.text, kind });
      if (context === "previous_seller") supportingTurns.add(id - 1);
    }
  }
  // Preserve the entire contiguous block around each independent source. A
  // condition in the next (or preceding) line must not disappear merely
  // because it lacks its own date or the model omitted its ID. Blank physical
  // lines, unknown labels and ambiguous/mixed turns delimit these blocks.
  // Context never creates a new evidence seed or upgrades an unknown seed.
  const retained = new Set([...accepted.keys(), ...supportingTurns]);
  for (const id of accepted.keys()) {
    const speaker = contextSpeaker(turns[id - 1].text);
    if (!speaker) continue;
    for (const direction of [-1, 1]) {
      let previous = id - 1;
      for (let index = previous + direction; index >= 0 && index < turns.length; index += direction) {
        // T06: a withdrawal line is not a caveat of the new timing; it must not lead or join the quotation.
        if (physicalLines[index].index !== physicalLines[previous].index + direction ||
          contextSpeaker(turns[index].text) !== speaker || withdrawalStatement.test(turns[index].text)) break;
        retained.add(turns[index].id);
        previous = index;
      }
    }
  }
  const ordered = turns.filter(({ id }) => retained.has(id));
  const contextSourceIds = ordered.filter(({ id }) => !accepted.has(id)).map(({ id }) => id);
  const quotes = ordered.map(({ text }) => text);
  const hasConcrete = [...accepted.values()].some((source) => source.kind === "concrete");
  let value = quotes.length ? `文字起こし記載: ${quotes.join("\n")}` : BANT_UNKNOWN_VALUES.timeline;
  if (quotes.length && !hasConcrete) {
    // An unknown Timeline must remain unknown in the existing BANT reader.
    // That reader exempts provisional monetary amounts from unknown-prefix
    // handling, so mixed monetary turns stay in audit quotes only.
    const containsAmount = /[\d０-９一二三四五六七八九十百千万億兆,.，．]+(?:億|万|千)?円|[¥￥][\d０-９,.，．]+/u.test(quotes.join("\n"));
    value = containsAmount ? BANT_UNKNOWN_VALUES.timeline : `${BANT_UNKNOWN_VALUES.timeline}\n${value}`;
  }
  return {
    value,
    sourceIds: ordered.map(({ id }) => id),
    sourceQuotes: quotes,
    contextSourceIds,
    rejectedSourceIds: rejectedSourceIds.filter((id) => typeof id !== "number" || !retained.has(id)),
  };
}
