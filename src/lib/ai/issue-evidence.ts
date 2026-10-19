import { timelineSourceTurns } from "./timeline-evidence";

type IssueRejectionReason = "invalid_source_ids" | "invalid_source_id" | "duplicate_source_id"
  | "duplicate_source_turn"
  | "seller_turn" | "seller_offer" | "ambiguous_speakers" | "question_only" | "empty_turn" | "bant_only"
  | "turn_limit_exceeded" | "source_character_budget_exceeded";

export interface IssueEvidenceAudit {
  /** The provider's requested references are retained without modification. */
  requestedSourceIds: unknown;
  accepted: Array<{
    sourceId: number;
    /** Includes adjacent unlabeled continuation lines, using the same input IDs. */
    sourceIds: number[];
    contextSourceIds: number[];
    sourceText: string;
    sourceRole: "customer" | "unspecified";
    publicText: string;
  }>;
  rejected: Array<{ sourceId: unknown; reason: IssueRejectionReason }>;
}

const MAX_TURNS = 8;
const MAX_SOURCE_CHARACTERS = 2400;
const seller = /^(?:営業(?:担当者?)?|当社|弊社|売り手|セールス)(?:$|[（(\s])/u;
const customer = /^(?:顧客|先方|お客様)(?:$|[（(\s])/u;
const extraSpeaker = /(?:^|[。！？!?\s])[^:：。！？!?\s\d０-９]{1,24}\s*[:：]/u;
const numberedSpeaker = /(?:^|[。！？!?\s])(?:話者|speaker)\s*[\d０-９]+\s*[:：]/iu;
const questionEnding = /[?？]\s*$|(?:です|ます|ません|でしょう|だろう|なの|なのです|よろしい|可能です|可能でしょう)か[。！!]?\s*$/u;
const acknowledgment = /^(?:はい|ええ|そうですね|ありがとうございます|なるほど)[。！!、,\s]*$/u;

function isQuestionOnly(body: string): boolean {
  const parts = (body.match(/[^。！？!?]+[。！？!?]?/gu) ?? []).map((part) => part.trim()).filter(Boolean);
  const meaningful = parts.filter((part) => !acknowledgment.test(part));
  return meaningful.length > 0 && meaningful.every((part) => questionEnding.test(part));
}

// 議事録「顧客の課題」用（T18 C3・C6・C7）。評価語の無い BANT の事実だけの定型の発言（金額の目安・上限、承認が未了、
// 時期・決裁者が未定、決裁者の名前、上長に相談、導入は未決定、情報交換です、条件の撤回）は BANT で扱う情報であり、課題ではない。
// 許可リストの形に当たる節だけでできた発言だけを除く。当たらない節（「決裁に時間がかかる」「費用が高い」など）が1つでもあれば残す。
const AMOUNT = String.raw`(?:約|およそ)?[\d０-９,，.．〇一二三四五六七八九十百千]+(?:万|億|千)?円(?:\s*[（(]?税(?:込|抜)[）)]?)?`;
const DATE = String.raw`(?:(?:\d{4}|[０-９]{4})年)?[\d０-９]{1,2}月(?:[\d０-９]{1,2}日)?(?:頃|ごろ|中|末|上旬|中旬|下旬)?`;
const BANT_ITEM = String.raw`(?:正式な)?(?:社内)?(?:予算|制作費|費用|導入時期|導入日|導入日程|時期|日程|決裁者|最終決裁者|決裁権者|承認経路|承認)`;
const BANT_FACT_CLAUSES: readonly RegExp[] = [
  // 予算の金額・目安・上限
  new RegExp(String.raw`^(?:現在の|最新の|今回の)?(?:検討上の)?(?:予算|制作費|費用)?(?:の)?(?:目安|上限)?(?:は|が)${AMOUNT}(?:を|が)?(?:目安|上限|総額|仮の目安)?(?:に|として)?(?:検討しています|考えています|見ています|です|になります|となります)?$`, "u"),
  // 承認が未了
  /^(?:正式な)?(?:社内)?(?:の)?承認(?:は|が)?(?:まだ)?(?:取れていません|取れていない|ありません|ない|未取得|未了|これから)(?:です)?$/u,
  // 予算・時期・決裁者などが未定・未確認
  new RegExp(String.raw`^(?:現在|現時点で(?:は)?|今は|今のところ)?、?${BANT_ITEM}(?:(?:と|や|・|、)${BANT_ITEM})*(?:は|が|も)(?:まだ)?(?:未定|未確定|未確認|決まっていません|決まっていない|分かりません|わかりません)(?:です)?$`, "u"),
  // 決裁者の名前・役職
  /^(?:今回の[^。、]{0,20}の)?(?:最終)?(?:決裁|決済|決裁者|決済者|決裁権者)(?:者)?は[^。、]{1,20}です$/u,
  /^(?:最終)?(?:決裁|決済)は[^。、]{1,20}が(?:行います|します|決めます)$/u,
  // 上長に相談
  /^(?:まず)?上長に相談(?:します|する予定です|するとは思います|すると思います)$/u,
  // 導入は未決定・時期の条件付き希望
  /^導入(?:は|するかどうか(?:も|は)?)(?:まだ)?決めていません$/u,
  new RegExp(String.raw`^導入(?:するなら|は)${DATE}(?:を|に)?(?:希望します|希望しています|予定しています)$`, "u"),
  // 今回の目的
  /^(?:今日|本日|今回)は情報(?:交換|収集)(?:です|が目的です)$/u,
  // 以前の条件の撤回・訂正
  /^(?:前回の|先ほどの)[^。]{0,60}(?:は|を)(?:撤回|訂正)します$/u,
];
const NEUTRAL_CLAUSE = /^(?:はい|ええ|ありがとうございます|承知しました|よろしくお願いします)$/u;

/** True only when every clause is a formulaic BANT fact without a problem or want. */
export function isBantOnlyStatement(body: string): boolean {
  const clauses = (body.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
    .flatMap((sentence) => sentence.split(/(?<=(?:ません|です|ます)が)、/u))
    .map((clause) => clause.replace(/[\s　]+/gu, "").replace(/[。！？!?、]+$/u, "").replace(/(?<=ません|です|ます)が$/u, ""))
    .filter(Boolean);
  // 希望（たい・ほしい）は BANT の話題と同じ節でも課題・希望として残す。
  if (clauses.some((clause) => /たい|ほしい|欲しい/u.test(clause))) return false;
  const facts = clauses.filter((clause) => BANT_FACT_CLAUSES.some((pattern) => pattern.test(clause)));
  return facts.length > 0 && clauses.every((clause) => facts.includes(clause) || NEUTRAL_CLAUSE.test(clause));
}

type SourceBlock = { sourceIds: number[]; sourceText: string; body: string; speaker?: string; start: number };

/**
 * T04: 話者ラベルの無い行の、営業側の申し出・作業の約束の言い回し（「〜を作って、目安をつけておきます」
 * 「候補をお聞かせします」「資料をお送りします」）。話者の分からない行だけに使い、課題の根拠にしない。
 * 「お願いします」は顧客の依頼にも使うため含めない。
 */
const unattributedSellerOffer = /(?:て|で)おきます[。．!！]?$|(?:お|ご)(?!願)[\p{Script=Han}\p{Script=Hiragana}]{1,10}(?:します|いたします|させていただきます)[。．!！]?$|ご提案(?:します|いたします)/u;

export interface SourceEvidenceBlock {
  readonly sourceIds: readonly number[];
  /** Complete original passage, including the speaker label and line endings. */
  readonly sourceText: string;
  readonly speaker?: string;
  readonly body: string;
  readonly sourceRole: "customer" | "seller" | "unspecified";
  readonly ambiguousSpeakers: boolean;
}

function labelledLine(line: string): { speaker: string; body: string } | null {
  const match = line.match(/^\s*([^:：。！？!?]{1,40})\s*[:：]\s*(.*)$/u);
  if (!match || /^[\d０-９\s]+$/u.test(match[1])) return null;
  return { speaker: match[1].trim(), body: match[2] };
}

/** Labels and blank lines delimit turns. Adjacent unlabeled lines are retained
 * as source context, never selected independently with a newly inferred role.
 * Preserve original line endings and spacing in the displayed passage.
 */
function sourceBlocks(transcript: string): Map<number, SourceBlock> {
  const turns = timelineSourceTurns(transcript);
  const blocks = new Map<number, SourceBlock>();
  let current: SourceBlock | undefined;
  let sourceIndex = 0;
  let offset = 0;
  for (const line of transcript.split(/\r?\n/u)) {
    const end = offset + line.length;
    if (!line.trim()) current = undefined;
    else {
      const sourceId = turns[sourceIndex++].id;
      const labelled = labelledLine(line);
      if (labelled || !current) {
        current = { sourceIds: [], sourceText: line, body: labelled?.body ?? line.trim(), speaker: labelled?.speaker, start: offset };
      } else {
        current.body += `\n${line}`;
        current.sourceText = transcript.slice(current.start, end);
      }
      current.sourceIds.push(sourceId);
      blocks.set(sourceId, current);
    }
    offset = end + (transcript.startsWith("\r\n", end) ? 2 : 1);
  }
  return blocks;
}

function hasRole(speaker: string | undefined, role: "seller" | "customer"): boolean {
  if (!speaker) return false;
  const pattern = role === "seller" ? seller : customer;
  return pattern.test(speaker) || pattern.test(speaker.match(/[（(]([^（）()]+)[）)]\s*$/u)?.[1] ?? "");
}

function hasAmbiguousSpeakers(body: string): boolean {
  return extraSpeaker.test(body) || numberedSpeaker.test(body);
}

/** Read complete source passages for any explicitly labelled or unknown role.
 * This applies no issue-specific filtering: questions, seller turns and empty
 * labelled passages remain available for callers to assess in their context.
 * References into the same continuation block share one object identity.
 */
export function readSourceEvidenceBlocks(transcript: string): ReadonlyMap<number, SourceEvidenceBlock> {
  const result = new Map<number, SourceEvidenceBlock>();
  const complete = new Map<SourceBlock, SourceEvidenceBlock>();
  for (const [sourceId, block] of sourceBlocks(transcript)) {
    let evidence = complete.get(block);
    if (!evidence) {
      evidence = {
        sourceIds: [...block.sourceIds],
        sourceText: block.sourceText,
        speaker: block.speaker,
        body: block.body,
        sourceRole: hasRole(block.speaker, "seller") ? "seller" : hasRole(block.speaker, "customer") ? "customer" : "unspecified",
        ambiguousSpeakers: hasAmbiguousSpeakers(block.body),
      };
      complete.set(block, evidence);
    }
    result.set(sourceId, evidence);
  }
  return result;
}

/**
 * Project selected complete source turns, never generated issue paraphrases.
 * The references select passages; they do not prove that every quoted sentence
 * is a confirmed problem or that a later suggestion follows from that passage.
 * Keeping the whole turn preserves subjects, conditions and adjoining caveats.
 * Unknown speaker labels remain unattributed; no role is inferred from content.
 */
export function groundIssueEvidence(transcript: string, requestedSourceIds: unknown, options: {
  /** 議事録の「顧客の課題」では、予算・時期・決裁者などだけの発言を選ばない。 */
  excludeBantOnly?: boolean;
} = {}): {
  issues: string[]; audit: IssueEvidenceAudit;
} {
  const audit: IssueEvidenceAudit = { requestedSourceIds, accepted: [], rejected: [] };
  if (!Array.isArray(requestedSourceIds)) {
    audit.rejected.push({ sourceId: null, reason: "invalid_source_ids" });
    return { issues: [], audit };
  }
  const blocks = sourceBlocks(transcript);
  const turns = timelineSourceTurns(transcript);
  // T04: 話者ラベルの無い複数行のまとまり（長い録音で区間の出力がラベルを落とした箇所など）は、営業の発言・質問・
  // 顧客の回答が混ざりうるため、まとめて採らず、選ばれた行だけを1つの根拠にする。ラベルのある発言の続き行は従来どおり。
  const unattributedLines = new Map<number, SourceBlock>();
  const issueBlock = (sourceId: number): SourceBlock => {
    const block = blocks.get(sourceId)!;
    if (block.speaker || block.sourceIds.length < 2) return block;
    let line = unattributedLines.get(sourceId);
    if (!line) {
      const text = turns[sourceId - 1].text;
      line = { sourceIds: [sourceId], sourceText: text, body: text.trim(), start: 0 };
      unattributedLines.set(sourceId, line);
    }
    return line;
  };
  const seen = new Set<number>();
  const acceptedBlocks = new Set<SourceBlock>();
  let sourceCharacters = 0;
  for (const sourceId of requestedSourceIds) {
    const reject = (reason: IssueRejectionReason) => audit.rejected.push({ sourceId, reason });
    if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || !blocks.has(sourceId)) {
      reject("invalid_source_id");
      continue;
    }
    if (seen.has(sourceId)) { reject("duplicate_source_id"); continue; }
    seen.add(sourceId);
    const block = issueBlock(sourceId);
    if (acceptedBlocks.has(block)) { reject("duplicate_source_turn"); continue; }
    const { sourceText, speaker, body } = block;
    if (hasRole(speaker, "seller")) { reject("seller_turn"); continue; }
    if (!body.trim()) { reject("empty_turn"); continue; }
    if (hasAmbiguousSpeakers(body)) { reject("ambiguous_speakers"); continue; }
    if (isQuestionOnly(body)) { reject("question_only"); continue; }
    if (!speaker && unattributedSellerOffer.test(body.trim())) { reject("seller_offer"); continue; }
    if (options.excludeBantOnly && isBantOnlyStatement(body)) { reject("bant_only"); continue; }
    if (audit.accepted.length >= MAX_TURNS) { reject("turn_limit_exceeded"); continue; }
    if (sourceCharacters + sourceText.length > MAX_SOURCE_CHARACTERS) {
      reject("source_character_budget_exceeded");
      continue;
    }
    const sourceRole = hasRole(speaker, "customer") ? "customer" : "unspecified";
    // 画面に出す課題の文は発言の本文だけ（UI確認 2026-10-01：「発言（話者の役割未確認・原文）: 話者2:」の前置きが各行に付いて読みにくかった）。
    // 本文は原文の発言そのもの（要約しない）で、話者ラベル付きの原文（sourceText）と話者の役割（sourceRole）は監査に残す。
    const publicText = body.trim();
    audit.accepted.push({ sourceId, sourceIds: [...block.sourceIds], contextSourceIds: block.sourceIds.filter((id) => id !== sourceId), sourceText, sourceRole, publicText });
    acceptedBlocks.add(block);
    sourceCharacters += sourceText.length;
  }
  audit.accepted.sort((left, right) => left.sourceIds[0] - right.sourceIds[0]);
  return { issues: audit.accepted.map((entry) => entry.publicText), audit };
}
