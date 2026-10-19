import { BANT_UNKNOWN_VALUES, type BantKey } from "./bant-definitions";

export type BantWithdrawal = { value: string; quote: string };

const topics = {
  budget: /予算|制作費|導入費用/u,
  timeline: /導入(?:の)?(?:時期|日程|予定|希望)?|運用開始|利用開始|本稼働|本番稼働|(?:動画|映像)(?:の)?(?:公開|納品)/u,
};
const unknownEnding = /(?:未定|未確認|未確定|不明)(?:です|である)?$/u;
const withdrawalVerb = "(?:撤回(?:します|しました|する|した|し)|取り下げ(?:ます|ました|る|た)|白紙に戻(?:します|しました|す)|取り消(?:します|しました|す))";
const withdrawal = new RegExp(`${withdrawalVerb}$`, "u");
const hypothetical = /もし|場合|なら|かもしれ|可能性|れば|撤回(?:する|した)と|取り下げると/u;
const question = /[?？]|(?:ます|です|ません|でしょう)か$/u;
const money = /[\d０-９一二三四五六七八九十百千万億兆,.]+(?:億|万|千)?円|[¥￥][\d,.]+/u;
const date = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|[\d０-９一二三四五六七八九十]+(?:年|月|日)|来年|来月|来春|年内/u;
type WithdrawalKey = "budget" | "timeline";

/** Match a field as the actual subject/object, not a nested person's or meeting's modifier. */
function hasFieldSubject(subject: string, key: WithdrawalKey): boolean {
  const amount = (key === "budget" ? money : date).source;
  const target = new RegExp(`(?:${topics[key].source})(?:\\s*(?:${amount}))?(?:の?(?:目安|希望|予定|条件|案|額|金額))?$`, "u");
  return subject.trim().replace(/(?:は|を|が|も)\s*$/u, "")
    .split(/(?:および|及び|並びに|と|や|[、,])/u)
    .some((part) => target.test(part.trim()));
}

function hasCurrentUnknown(statement: string, key: WithdrawalKey): boolean {
  const predicate = statement.match(unknownEnding);
  return !!predicate && hasFieldSubject(statement.slice(0, predicate.index), key);
}

function hasWithdrawal(statement: string, key: WithdrawalKey): boolean {
  const predicate = statement.match(withdrawal);
  return !!predicate && !hypothetical.test(statement) && hasFieldSubject(statement.slice(0, predicate.index), key);
}

/** A later number by itself, a denial, or a hypothetical resource is not a replacement. */
function hasReplacement(statement: string, key: WithdrawalKey): boolean {
  if (/撤回|取り下げ|取り消|白紙に戻/u.test(statement)) return false;
  if (/(?:では|じゃ)(?:ない|ありません)|(?:でき|し|確保でき)(?:ない|ません)|無理|不可能|(?:ない|ません)$/u.test(statement)) return false;
  // A stated hope conditional on adoption is useful provisional timing. Other
  // hypotheticals (e.g. "もし120万円を確保できれば") do not establish a new value.
  const conditionalHope = key === "timeline" && /導入するなら.+希望/u.test(statement) &&
    !/もし|場合|かもしれ|可能性|れば/u.test(statement);
  if (hypothetical.test(statement) && !conditionalHope) return false;
  if (/前回|以前|当時|過去/u.test(statement) && !/現在|今回は|新た|変更後/u.test(statement)) return false;
  const number = key === "budget" ? money : date;
  if (!/目安|希望|予定|検討|確保|承認済|決定|合意|したい|とします|とする|にします|です$|である$/u.test(statement) &&
    !new RegExp(`(?:${number.source})$`, "u").test(statement)) return false;
  for (const match of statement.matchAll(new RegExp(number.source, "gu"))) {
    const before = statement.slice(0, match.index).replace(/導入するなら$/u, "導入");
    if (hasFieldSubject(before, key)) return true;
    const after = statement.slice(match.index + match[0].length)
      .replace(/^(?:の|に|を|で|から|まで|中|末|上旬|中旬|下旬|以降|\s)+/u, "");
    if (new RegExp(`^(?:${topics[key].source})(?:は|を|が)?(?:希望|予定|計画|決定|確保|検討|したい|目安|です|である|$)`, "u").test(after)) return true;
  }
  return false;
}

function sourceStatements(line: string): string[] {
  const body = line.replace(/^\s*(?:顧客|先方|お客様)\s*[:：]/u, "").normalize("NFKC")
    .replace(new RegExp(`(${withdrawalVerb})[、,]`, "gu"), "$1。");
  // Contrast joins delimit subjects: "導入時期は変更しませんが、予算は撤回"
  // withdraws only the budget. A comma inside a shared object stays intact.
  return (body.match(/[^。！？!?]+[！？!?]?/gu) ?? [])
    .flatMap((statement) => statement.split(/(?:ですが|ますが|ませんが|だが|けれど(?:も)?|[；;])/u))
    .map((statement) => statement.trim()).filter(Boolean);
}

/** The customer-line check used by findBantWithdrawal (one explicit customer label, no second speaker). */
function customerLine(line: string): boolean {
  const match = line.match(/^\s*(顧客|先方|お客様)\s*[:：]([\s\S]*)$/u);
  return !!match && !/(?:営業|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u.test(match[2]) &&
    !/(?:^|[\s。！？!?])[^\s:：\d０-９]{1,20}\s*[:：]/u.test(match[2]);
}

/** Longer statements are kept conservatively instead of running the per-match replacement check (quadratic in length). */
const MAX_REPLACEMENT_CHECK_CHARS = 2_000;

/**
 * Physical line indices (split on "\n") that findBantWithdrawal depends on:
 * customer lines with a withdrawal or a present-unknown statement, the lines
 * from a withdrawal to the next present-unknown or replacement in the same
 * customer block, and lines after the first withdrawal of the same field that
 * state a replacement. The long-record excerpt (long-transcript.ts) always
 * keeps these lines so the withdrawal decision is the same as on the full
 * transcript. The decision itself (findBantWithdrawal) is unchanged.
 */
export function bantWithdrawalEvidenceLines(original: string): number[] {
  const result = new Set<number>();
  const withdrawnSince: Partial<Record<WithdrawalKey, number>> = {};
  // Withdrawal line per field inside the current block of one customer label.
  let open: Partial<Record<WithdrawalKey, number>> = {};
  let blockLabel = "";
  original.split("\n").forEach((line, index) => {
    const label = customerLine(line) ? line.match(/^\s*(顧客|先方|お客様)/u)![1] : "";
    if (label !== blockLabel) open = {};
    blockLabel = label;
    if (!label) return;
    for (const raw of sourceStatements(line)) {
      const statement = raw.trim();
      if (question.test(statement)) continue;
      for (const key of ["budget", "timeline"] as const) {
        const closeTo = (from: number | undefined) => {
          if (from === undefined) return;
          for (let at = from; at <= index; at++) result.add(at);
          delete open[key];
        };
        if (hasWithdrawal(statement, key)) {
          withdrawnSince[key] ??= index;
          open[key] ??= index;
          result.add(index);
        } else if (hasCurrentUnknown(statement, key)) {
          result.add(index);
          closeTo(open[key]);
        } else if (withdrawnSince[key] !== undefined
          && (statement.length > MAX_REPLACEMENT_CHECK_CHARS ? topics[key].test(statement) : hasReplacement(statement, key))) {
          result.add(index);
          closeTo(open[key]);
        }
      }
    }
  });
  return [...result].sort((a, b) => a - b);
}

/**
 * Narrow primary-source update: an explicit customer withdrawal followed by
 * present uncertainty for the same field. This is not a general NLP parser.
 * A question, hypothetical, generated BANT, or an unlabeled/mixed turn cannot
 * withdraw earlier evidence. Original text is retained without rewriting it.
 */
export function findBantWithdrawal(original: string, key: BantKey): BantWithdrawal | null {
  if (key !== "budget" && key !== "timeline") return null;
  const blocks: string[][] = [];
  let block: string[] = [];
  let speaker = "";
  for (const line of original.split("\n")) {
    const match = line.match(/^\s*(顧客|先方|お客様)\s*[:：]([\s\S]*)$/u);
    const valid = match && !/(?:営業|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u.test(match[2]) &&
      !/(?:^|[\s。！？!?])[^\s:：\d０-９]{1,20}\s*[:：]/u.test(match[2]);
    if (!valid || match[1] !== speaker) {
      if (block.length) blocks.push(block);
      block = [];
    }
    if (valid) { block.push(line); speaker = match[1]; }
    else speaker = "";
  }
  if (block.length) blocks.push(block);

  let result: BantWithdrawal | null = null;
  for (const lines of blocks) {
    let withdrawn = false;
    let nowUnknown = false;
    const statements = lines.flatMap(sourceStatements);
    for (const raw of statements) {
      const statement = raw.trim();
      if (question.test(statement)) continue;
      if (hasWithdrawal(statement, key)) {
        withdrawn = true;
        nowUnknown = false;
        continue;
      }
      if (hasCurrentUnknown(statement, key)) {
        if (withdrawn) nowUnknown = true;
        continue;
      }
      // A later explicit replacement ends the withdrawal; retaining the old
      // date merely as historical context does not create a replacement.
      if (hasReplacement(statement, key)) {
        withdrawn = false;
        nowUnknown = false;
        result = null;
      }
    }
    if (withdrawn && nowUnknown) result = { value: BANT_UNKNOWN_VALUES[key], quote: lines.join("\n") };
  }
  return result;
}
