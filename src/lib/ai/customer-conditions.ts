/** Literal, bounded adoption conditions. Never infer a condition from a date alone. */
export function customerAdoptionConditions(transcript: string): Array<{ quote: string; turn: string }> {
  const conditions: Array<{ quote: string; turn: string }> = [];
  for (const line of transcript.split(/\r?\n/u)) {
    const match = line.trim().match(/^(顧客|先方|お客様)\s*[:：]\s*(.+)$/u);
    if (!match || line.length > 2000 || /(?:営業|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u.test(match[2])) continue;
    const sentences = match[2].match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
    for (const sentence of sentences) {
      const normalized = sentence.normalize("NFKC").replace(/\s+/gu, "");
      if (sentence.length > 300 || /[?？]|予算|面談|会議|打ち合わせ/u.test(normalized)) continue;
      if (!/導入するなら(?:\d{4}年)?\d{1,2}月(?:\d{1,2}日)?(?:を|の)?希望(?:します|してい(?:ます|る)|です)?[。.]?$/u.test(normalized)) continue;
      const quote = sentence.trim();
      if (!conditions.some((entry) => entry.quote === quote)) conditions.push({ quote, turn: line.trim() });
      if (conditions.length === 2) return conditions;
    }
  }
  return conditions;
}

export function retainAdoptionConditions(summary: string, source: string, verifiedQuote = source): string {
  // Preserve actual speaker attribution from the current source transcript.
  // A literal substring alone is not proof that the customer said it.
  if (!verifiedQuote || !source.includes(verifiedQuote)) return summary;
  const missing = customerAdoptionConditions(source).filter(({ quote }) => verifiedQuote.includes(quote) && !summary.includes(quote));
  return [summary, ...missing.map(({ quote }) => `顧客発言（原文）: ${quote}`)].filter(Boolean).join("\n");
}

// Only date/candidate annotations attached to the next meeting are recognized.
// Never consume arbitrary parenthetical prose or an unrelated absolute deadline.
const meetingDate = "(?:(?:[0-9０-９]{4}年)?[0-9０-９]{1,2}月[0-9０-９]{1,2}日|(?:[0-9０-９]{4}[-/])?[0-9０-９]{1,2}[-/][0-9０-９]{1,2})(?:[（(][月火水木金土日](?:曜日)?[）)])?";
const annotationSpace = "[ \\t\\u3000]{0,3}";
const meetingAnnotation = `(?:(?:(?:候補日?|予定日?|日程)[:：]${annotationSpace})?${meetingDate}${annotationSpace}(?:候補|予定)?|(?:候補日?|予定日?)(?:調整中)?|日程調整中)`;
const annotatedMeeting = `(?:\\(${annotationSpace}${meetingAnnotation}${annotationSpace}\\)|（${annotationSpace}${meetingAnnotation}${annotationSpace}）)`;
const nextMeetingReference = `次回(?:の)?(?:面談|商談|打ち合わせ|打合せ)(?:(?:の)?(?:候補日|予定日))?(?:(?:である|の)?${meetingDate}|${annotatedMeeting})?`;
const nextMeetingDeadline = new RegExp(
  `${nextMeetingReference}(?:の前|前|まで)に[、，,\\s]*`,
  "gu",
);
// A prepared presentation also imposes timing, even without "までに". Ordinary
// discussion during a meeting is outside this narrowly observed form.
const nextMeetingPresentation = new RegExp(
  `${nextMeetingReference}(?:の)?時に[、，, \\t\\u3000]*(?=提示できるよう[^。！？!?\\r\\n]{0,60}(?:準備|用意))`, "gu",
);
const recommendationDeadline = new RegExp(
  `${nextMeetingDeadline.source}|(?:その|当該(?:の)?)(面談|商談|打ち合わせ|打合せ)(?:の前|前|まで)に[、，,\\s]*|${nextMeetingPresentation.source}`, "gu",
);
const nextMeetingCandidate = new RegExp(
  `次回(?:の)?(面談|商談|打ち合わせ|打合せ)(?:(?:の)?候補日(?:(?:である|の)?${meetingDate})?|${annotatedMeeting})`, "gu",
);

/** Resolve only a same-line candidate antecedent with no intervening meeting.
 * Other/ambiguous meetings and cross-line pronouns are deliberately untouched.
 */
function hasCandidateAntecedent(beforeDeadline: string, meetingKind: string): boolean {
  const candidate = [...beforeDeadline.matchAll(nextMeetingCandidate)].at(-1);
  if (!candidate || candidate[1] !== meetingKind) return false;
  if (/(?:別の|別件の|他社の)$/u.test(beforeDeadline.slice(0, candidate.index))) return false;
  return !/面談|商談|打ち合わせ|打合せ/u.test(beforeDeadline.slice(candidate.index! + candidate[0].length));
}

/** Protect the quoted occurrence, not every recommendation sharing its sentence.
 * Keep nested/multiline quotation spans intact. An unmatched opening quote
 * conservatively protects the remainder rather than guessing its endpoint.
 */
function quotationSpans(text: string): Array<{ start: number; end: number }> {
  const closing = new Map([["「", "」"], ["『", "』"], ["“", "”"], ['"', '"']]);
  const stack: Array<{ start: number; closing: string }> = [];
  const spans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      let escapes = 0;
      for (let before = index - 1; before >= 0 && text[before] === "\\"; before--) escapes++;
      if (escapes % 2) continue;
    }
    if (stack.length && character === stack[stack.length - 1].closing) {
      const opened = stack.pop()!;
      if (!stack.length) spans.push({ start: opened.start, end: index + 1 });
    } else {
      const endQuote = closing.get(character);
      if (endQuote) stack.push({ start: index, closing: endQuote });
    }
  }
  if (stack.length) spans.push({ start: stack[0].start, end: text.length });
  return spans;
}

const literalSourceField = /^(?:quote|source_quote|sourceText|transcript)$/u;
const literalSourceLabel = /^\s*(?:原文|文字起こし記載|(?:顧客発言|発言|顧客が明示した内容)（[^）\r\n]*原文[^）\r\n]*）)\s*[:：]/u;
/** Also read by the long-record excerpt (long-transcript.ts) to keep the lines this guard reads. */
export const nextMeetingMention = /次回(?:の)?(?:面談|商談|打ち合わせ|打合せ)/u;
const meetingPresentationRequest = new RegExp(`${nextMeetingReference}(?:の)?時に[^。！？!?\\r\\n]{0,60}(?:提示|提出|共有)`, "u");
const confirmationContact = /確定(?:の)?(?:連絡|通知)を(?:行う|する)/gu;
const internalScheduleBeforeContact = /社内(?:の)?(?:スケジュール|予定|空き状況)を確認し[、,]\s*(?:顧客|先方|お客様)(?:へ|に)\s*$/u;

/** Narrow guard for an explicit customer statement that submission deadlines
 * remain unagreed. A later mention of a deadline makes this repair inapplicable;
 * do not overwrite a subsequent agreement based on an earlier denial.
 */
export function constrainUnagreedSubmissionDeadline<T>(transcript: string, value: T): { value: T; applied: boolean } {
  let unagreed = false;
  let meetingUnagreed = false;
  for (const line of transcript.split(/\r?\n/u)) {
    const customer = line.match(/^\s*(?:顧客|先方|お客様)\s*[:：]\s*(.+)$/u);
    if (!customer || /(?:営業|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u.test(customer[1])) continue;
    for (const sentence of customer[1].match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
      if (nextMeetingMention.test(sentence) && /日程|予定|確定|合意/u.test(sentence)) {
        meetingUnagreed = /(?:未合意|未確定|確定していません)/u.test(sentence)
          && !/[?？「」『』]|もし|仮に|なら|場合|他社|別会社/u.test(sentence);
      }
      if (/(?:期限|までに|以内に)/u.test(sentence) || meetingPresentationRequest.test(sentence)) {
        unagreed = /(?:資料|企画|提案|見積)[^。]{0,20}(?:提出|送付)?期限(?:も|は|が)(?:未合意|未確定|未定)/u.test(sentence)
          && !/[?？「」『』]|もし|仮に|なら|場合|他社|別会社/u.test(sentence);
      }
    }
  }
  if (!unagreed) return { value, applied: false };
  let applied = false;
  const visit = (part: unknown, field = ""): unknown => {
    if (typeof part === "string") {
      if (literalSourceField.test(field) || literalSourceLabel.test(part) || transcript.includes(part)) return part;
      const quotes = quotationSpans(part);
      const unquoted = quotes.reduce((masked, quote) =>
        masked.slice(0, quote.start) + " ".repeat(quote.end - quote.start) + masked.slice(quote.end), part);
      return part.replace(/[^\r\n]+/gu, (line, lineOffset: number) => {
        // A flattened plan may contain several sentences under nested labels.
        // Determine their role from the whole line before splitting sentences.
        let descriptive = /^(?:reason|expected_outcome|risks?)$/u.test(field);
        let remaining = line.replace(/^[ \t\u3000]*(?:(?:[-*+・•]|[0-9０-９]+[.)、．）])[ \t\u3000]*)?/u, "");
        const labelPattern = /^(行動|対応|内容|次の行動|手順|理由|根拠|期待結果|期待される結果|期待される成果|期待効果|期待成果|成果|リスク|懸念|勝ち筋|戦略|差別化|クロージング計画|見出し|要約|詳細|目的|目標|条件|期限|時期|担当|優先度|影響|補足|[0-9０-９]+週目|手順[0-9０-９]+|段階[0-9０-９]+)[ \t\u3000]*[:：][ \t\u3000]*/u;
        for (let label = remaining.match(labelPattern); label; label = remaining.match(labelPattern)) {
          if (/^(?:理由|根拠|期待結果|期待成果|成果|期待効果|期待される結果|期待される成果|リスク|懸念)$/u.test(label[1])) descriptive = true;
          else if (/^(?:行動|対応|次の行動)$/u.test(label[1])) descriptive = false;
          remaining = remaining.slice(label[0].length);
        }
        return line.replace(/[^。]+[。]?/gu, (sentence, sentenceOffset: number) => {
          const start = lineOffset + sentenceOffset;
          if (/未合意|未確定|未定|合意していな|合意していません/u.test(unquoted.slice(start, start + sentence.length))) return sentence;
          // Remove only the unsupported temporal phrase in descriptive fields,
          // keeping the original subject and predicate. Preserve action instructions.
          const repairable = (offset: number, length: number) => !quotes.some(quote => start + offset < quote.end && start + offset + length > quote.start);
          let repaired = sentence.replace(recommendationDeadline, (deadline, anaphoricKind: string | undefined, offset: number) => {
            const deadlineStart = start + offset;
            if (!repairable(offset, deadline.length)) return deadline;
            if (anaphoricKind && !hasCandidateAntecedent(unquoted.slice(lineOffset, deadlineStart), anaphoricKind)) return deadline;
            if (/時に/u.test(deadline) && /(?:日程|日時|予定)(?:が|を)(?:確定|合意)(?:したら|できたら|できれば|した場合|できた場合)[、,]?\s*$/u.test(unquoted.slice(start, deadlineStart))) return deadline;
            return descriptive ? "" : "期限を確認したうえで、";
          });
          // A seller's internal schedule check cannot establish a still-unagreed
          // customer date. Keep the candidate and change only that contact's aim.
          if (meetingUnagreed && !descriptive) {
            repaired = repaired.replace(confirmationContact, (contact, offset: number) => {
              // Temporal edits can move offsets; inspect the original sentence.
              if (repaired !== sentence) return contact;
              const before = unquoted.slice(start, start + offset);
              const candidate = [...before.matchAll(nextMeetingCandidate)].at(-1);
              if (!candidate || !hasCandidateAntecedent(before, candidate[1]) || !internalScheduleBeforeContact.test(before)
                || !repairable(offset, contact.length) || /^(?:か|のか|とは|わけでは)/u.test(sentence.slice(offset + contact.length))) return contact;
              return "双方の日程調整に向けた連絡を行う";
            });
          }
          if (repaired !== sentence) applied = true;
          return repaired;
        });
      });
    }
    if (Array.isArray(part)) return part.map(item => visit(item, field));
    if (part && typeof part === "object") return Object.fromEntries(Object.entries(part).map(([key, item]) => [key, visit(item, key)]));
    return part;
  };
  const repaired = visit(value) as T;
  return { value: applied ? repaired : value, applied };
}
