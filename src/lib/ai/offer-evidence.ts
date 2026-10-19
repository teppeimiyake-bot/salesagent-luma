const SAFE_OFFER_CONFIRMATION = "各商材の提供範囲と見積を社内で確認し、顧客の目安予算に収まる場合に説明する。";
const SAFE_OFFER_REASON = "各商材の提供範囲と見積が未確認のため、顧客の目安予算に収まるか確認が必要。";
const SAFE_OFFER_OUTCOME = "提供範囲と見積を確認できれば、顧客の目安予算に収まるか判断できる。";
const SAFE_OFFER_RISK = "各商材の提供範囲と見積が未確認のまま進めると、顧客の目安予算に収まらない可能性がある。";
const moneySource = "(?<![0-9,.])(?:[0-9][0-9,]*(?:\\.[0-9]+)?)(?:億|万|千)?円";
const provisionSource = "(?:提供|実現)(?:可能|できる|できます|する|します)";
const priceBasisSource = `(?:(?:${moneySource}(?:\\(目安\\))?|\\(${moneySource}\\))(?:(?:の)?(?:目安)?予算(?:内|の範囲内)?|以内|内|の範囲内)?(?:で|なら)|(?:目安)?予算(?:内|の範囲内)?で)`;
const offerClaim = new RegExp(`${priceBasisSource}[^。！？!?\\r\\n]{0,90}?${provisionSource}`, "gu");
// Presenting concrete choices and their price breakdown as within budget also
// presupposes a scoped quote, even without a provision/feasibility verb.
const optionPresentation = new RegExp(`${priceBasisSource}[^。！？!?\\r\\n]{0,100}?選択肢[^。！？!?\\r\\n]{0,100}?提示(?:し(?=[、,])|する)`, "gu");
const withinBudgetClaim = /予算内|範囲内|以内|円(?:\(目安\)|\))?内/u;
const customerLabel = /^\s*(?:顧客|先方|お客様)\s*[:：](.*)$/u;
const sellerLabel = /^\s*(?:営業(?:担当者?)?|当社|弊社|売り手)\s*[:：](.*)$/u;
const extraSpeaker = /(?:顧客|先方|お客様|営業(?:担当者?)?|当社|弊社|売り手)\s*[:：]/u;

type Recommendations = { topSales: unknown; strategy: unknown; nextActions: unknown; analysis?: unknown };

/** Only retain presentation prefixes, never arbitrary prose from a rejected claim.
 * Structured prose is decoded before this guard; JSON is not parsed here.
 */
function offerPresentation(sentence: string, semanticField?: string): { prefix: string; semanticField?: string } {
  const layout = sentence.match(/^[ \t\u3000]*(?:(?:[-*+・•]|[0-9０-９]+(?:[.．](?![0-9０-９])|[)）、])|[（(][0-9０-９]+[)）])[ \t\u3000]*)?/u)?.[0] ?? "";
  let prefix = layout;
  const semanticLabels: Record<string, string> = {
    行動: "action", 対応: "action", 次の行動: "action",
    理由: "reason", 根拠: "reason",
    期待される結果: "expected_outcome", 期待される成果: "expected_outcome", 期待効果: "expected_outcome", 期待成果: "expected_outcome", 成果: "expected_outcome",
    リスク: "risk", 懸念: "risk",
  };
  const labelPattern = /^(行動|対応|内容|次の行動|手順|理由|根拠|期待される結果|期待される成果|期待効果|期待成果|成果|リスク|懸念|勝ち筋|戦略|差別化|クロージング計画|見出し|要約|詳細|目的|目標|条件|期限|時期|担当|優先度|影響|補足|[0-9０-９]+週目|手順[0-9０-９]+|段階[0-9０-９]+)[ \t\u3000]*[:：][ \t\u3000]*/u;
  for (let label = sentence.slice(prefix.length).match(labelPattern); label; label = sentence.slice(prefix.length).match(labelPattern)) {
    prefix += label[0];
    semanticField = semanticLabels[label[1]] ?? semanticField;
  }
  return { prefix, semanticField };
}

function safeOfferSentence(sentence: string, lineField?: string): string {
  const { prefix, semanticField } = offerPresentation(sentence, lineField);
  const replacement = /^(?:理由|根拠|reason)$/u.test(semanticField ?? "") ? SAFE_OFFER_REASON
    : /^(?:期待される結果|期待される成果|期待効果|期待成果|expected_outcome)$/u.test(semanticField ?? "") ? SAFE_OFFER_OUTCOME
      : /^(?:リスク|懸念|risks?)$/u.test(semanticField ?? "") ? SAFE_OFFER_RISK
        : SAFE_OFFER_CONFIRMATION;
  return `${prefix}${replacement}`;
}

function amounts(text: string): number[] {
  return [...text.matchAll(new RegExp(moneySource, "gu"))].map(([amount]) => {
    const scale = amount.includes("億") ? 100000000 : amount.includes("万") ? 10000 : amount.includes("千") ? 1000 : 1;
    return Number(amount.replace(/[,億万千円]/gu, "")) * scale;
  });
}

/** A qualifier must govern the provision claim, not an unrelated unknown fact. */
function isQualified(clause: string, match: RegExpMatchArray): boolean {
  const tail = clause.slice(match.index! + match[0].length).replace(/^[」』”"）)]/u, "").replace(/^(?:です|である)/u, "");
  // "可能か、選択肢を提示する / イメージを持ってもらう" promises an
  // explanation of affordable offerings; the comma alone is not a check.
  const presentationQuestion = /^(?:なの|の)?か(?:どうか)?[、,]\s*(?:複数の選択肢[^。！？!?]{0,100}?(?:提示|説明)|具体的なイメージを(?:持|描|つか))/u.test(tail);
  if (!presentationQuestion && /^(?:なの|の)?か(?:どうか)?(?:[?？。、,]|$|(?:を|は|について)?(?:社内で|社内に|顧客に)?(?:確認|質問|尋ね|検討)|(?:は|が)?(?:未確認|不明)|によって)|^[?？]/u.test(tail)) return true;
  if (/^(?:場合|とき|際|(?:の)?なら|のであれば|とすれば)|^(?:と|ことが|ということが)(?:確認|判明)(?:できた|された|した)場合/u.test(tail)) return true;
  if (/^(?:では(?:ない|ありません)|とは(?:限らない|言えない|いえない)|と(?:は)?(?:断定|判断)(?:できない|できません|しない|しません)|わけでは(?:ない|ありません))/u.test(tail)) return true;
  if (/^(?:な|の)?(?:範囲|内容|商材|サービス|事実)(?:を|は)?(?:前提に(?:しない|しません|せず)|断定(?:しない|しません|できない|できません))/u.test(tail)) return true;
  if (/^(?:(?:という)?(?:こと|事実|根拠|範囲)|(?:な|の)(?:範囲|内容|商材|サービス))?(?:は|が|も)?(?:まだ)?(?:未確認|不明|未確定|確認でき(?:ない|ません)|分からない)/u.test(tail)) return true;
  if (/^(?:という|といった)?(?:記載|根拠|証拠)(?:は|が)(?:原文に)?(?:ない|ありません)/u.test(tail)) return true;
  if (/^(?:かもしれない|かもしれません|可能性)/u.test(tail)) return true;
  return /^(?:な|の)?(?:範囲|内容|商材|サービス|プラン)(?:の)?(?:有無|可否)(?:を|について)?(?:社内で|社内に|顧客に)?(?:確認|質問|尋ね)/u.test(tail);
}

function canonicalProposition(value: string): string {
  return value.replace(/\s+/gu, "").replace(/[。！？!?「」『』]/gu, "")
    .replace(/(?:提供|実現)(?:できます|できる|可能(?:です|である)?)/gu, "提供可")
    .replace(/(?:です|である)$/u, "");
}

/** Limited noun lists adjacent to a provision verb; ambiguous wording is not evidence. */
function offerNames(clause: string, match: RegExpMatchArray): string[] {
  const after = clause.slice(match.index! + match[0].length);
  const adjective = after.match(/^な(.{1,60}?)(?:の内容|について|を|が|は|など|[。！？!?]|$)/u)?.[1];
  const inside = match[0].replace(new RegExp(`^${priceBasisSource}`, "u"), "")
    .replace(new RegExp(`${provisionSource}$`, "u"), "")
    .replace(/^(?:の目安予算内|の予算内|以内|の範囲内|で|に|は|を)+/u, "").replace(/(?:を|は|が)$/u, "");
  const before = clause.slice(0, match.index).match(/(?:^|[、,])([^、,]{2,50})(?:は|を)$/u)?.[1];
  const text = adjective || inside || before || "";
  return text.split(/や|及び|および|と|[、,]/u).map((name) => name.trim().replace(/サービス$/u, ""))
    .filter((name) => /^[\p{L}\p{N}ー()（）・]{2,40}$/u.test(name));
}

function sellerSupports(clause: string, match: RegExpMatchArray, sellerStatements: string[], budgets: number[], namedOptions?: string[]): boolean {
  const claimAmounts = amounts(match[0]);
  const limits = claimAmounts.length ? claimAmounts : budgets;
  const names = namedOptions ?? offerNames(clause, match);
  return sellerStatements.some((source) => {
    const sourceMatches = [...source.matchAll(offerClaim)];
    return sourceMatches.some((sourceMatch) => {
      if (isQualified(source, sourceMatch) || /もし|仮に|場合|なら|れば|予定|見込|かもしれ|前回|以前|当時|撤回/u.test(source)) return false;
      const prices = amounts(sourceMatch[0]);
      const sourceNames = offerNames(source, sourceMatch);
      const withinBudget = withinBudgetClaim.test(match[0]);
      const afterClaim = clause.slice(match.index! + match[0].length);
      const sameOffer = names.length > 0 ? names.every((name) => sourceNames.includes(name))
        : sourceNames.length === 0 && canonicalProposition(match[0]) === canonicalProposition(sourceMatch[0])
          && /^(?:[。！？!?]|$|と(?:説明|伝え)|です(?:[。！？!?]|$))/u.test(afterClaim);
      return prices.length === 1 && limits.length > 0
        && limits.every((limit) => withinBudget ? prices[0] <= limit : prices[0] === limit)
        && sameOffer;
    });
  });
}

function unsupportedOptionPresentation(clause: string, sellerStatements: string[], budgets: number[]): boolean {
  return [...clause.matchAll(optionPresentation)].some((match) => {
    if (!withinBudgetClaim.test(match[0])) return false;
    const tail = clause.slice(match.index! + match[0].length);
    if (!/^[、,]?[^。！？!?]{0,50}?費用(?:の)?内訳[^。！？!?]{0,80}?説明(?:する|します)/u.test(tail) || isQualified(clause, match)) return false;
    const listed = match[0].match(/選択肢[（(]([^（）()]{1,100})[）)]/u)?.[1] ?? "";
    const names = listed.replace(/など$/u, "").split(/や|及び|および|と|[、,]/u)
      .map((name) => name.trim().replace(/サービス$/u, ""))
      .filter((name) => /^[\p{L}\p{N}ー・]{2,40}$/u.test(name));
    return !sellerSupports(clause, match, sellerStatements, budgets, names);
  });
}

/**
 * Bounded Japanese budget/provision guard. Customer money is not a seller quote.
 * It only applies with an explicitly labelled customer budget and does not try
 * to infer offer prices, product scope or unlabelled speaker identities.
 */
export function constrainOfferEvidence<T extends Recommendations>(transcript: string, recommendations: T): {
  value: T; applied: boolean; changedPaths: string[]; reason: "unverified_budget_providability" | null;
} {
  const budgets: number[] = [];
  const sellerStatements: string[] = [];
  for (const raw of transcript.normalize("NFKC").split(/\r?\n/u)) {
    const customer = raw.match(customerLabel);
    const seller = raw.match(sellerLabel);
    const body = customer?.[1] ?? seller?.[1];
    if (!body || extraSpeaker.test(body)) continue;
    for (const clause of body.match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
      if (customer && /予算|制作費|費用/u.test(clause) && !/[?？]|もし|なら|場合|撤回|取り下げ/u.test(clause)) budgets.push(...amounts(clause));
      if (seller && !/[?？]|もし|なら|場合|れば|未確認|不明|予定|かもしれ|できない|できません|ではない|ではありません|撤回/u.test(clause)
        && [...clause.matchAll(offerClaim)].some((match) => !isQualified(clause, match))) sellerStatements.push(clause);
    }
  }
  const changedPaths: string[] = [];
  if (!budgets.length) return { value: recommendations, applied: false, changedPaths, reason: null };
  const visit = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const pathField = path.match(/(?:^|\.)(reason|expected_outcome|risks?)(?:\[\d+\])*$/u)?.[1];
      const replaced = value.replace(/[^\r\n]+/gu, (line) => {
        // Decoded prose repeats labels per line, but a field can contain several
        // sentences. Keep that role throughout the line without copying labels.
        const { semanticField } = offerPresentation(line, pathField);
        return line.replace(/[^。！？!?\r\n]+[。！？!?]?/gu, (sentence) => {
          const normalized = sentence.normalize("NFKC");
          const unsupported = [...normalized.matchAll(offerClaim)].some((match) =>
            !isQualified(normalized, match) && !sellerSupports(normalized, match, sellerStatements, budgets))
            || unsupportedOptionPresentation(normalized, sellerStatements, budgets);
          return unsupported ? safeOfferSentence(sentence, semanticField) : sentence;
        });
      });
      if (replaced !== value) changedPaths.push(path);
      return replaced;
    }
    if (Array.isArray(value)) {
      const result = value.map((entry, index) => visit(entry, `${path}[${index}]`));
      return result.some((entry, index) => entry !== value[index]) ? result : value;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value).map(([key, entry]) => [key, visit(entry, path ? `${path}.${key}` : key)] as const);
      return entries.some(([key, entry]) => entry !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value;
    }
    return value;
  };
  const value = visit(recommendations, "") as T;
  return { value, applied: changedPaths.length > 0, changedPaths, reason: changedPaths.length ? "unverified_budget_providability" : null };
}
