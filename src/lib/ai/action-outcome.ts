const MATERIALS = "(?:事例資料|事例|資料|データ)(?:(?:や|及び|および|と|、|・)(?:利用可能な|提供可能な|提示可能な|具体的な|関連する)?(?:事例資料|事例|資料|データ))*";
const availabilityCheck = new RegExp(
  `(${MATERIALS})(?:の|が)?(?:有無|利用可否|提供可否|存在(?:するか(?:どうか)?|の有無)?)(?:と内容|や内容)?(?:を|について)?(?:社内で|社内に|営業が|営業担当が|顧客に|顧客と|関係者に)?(?:確認する|確認します|確認し(?=[、,て])|確認を行う|調べる|調べます|調べ(?=[、,て]))`,
  "gu",
);
const availabilityClaim = new RegExp(
  `(${MATERIALS})(?:を|が|は|も)(?:(?:顧客|相手)(?:へ|に)|社内で|直接|具体的に|安全に|適切に|いつでも|すぐに|確実に|新たに|[、,\\s]){0,3}(?:提供|提示)(?:できる(?:ようにな(?:ります|り|る))?|できます|可能)`,
  "gu",
);
type ActionOutcomes = { next_actions: Array<{ action: string; expected_outcome: string }> };

function materialKinds(value: string): Set<string> {
  return new Set(value.match(/事例|資料|データ/gu) ?? []);
}

function checkedMaterials(action: string): Set<string> {
  const checked = new Set<string>();
  for (const sentence of action.match(/[^。！？!?\r\n]+[。！？!?]?/gu) ?? []) {
    // Questions and quotations do not establish an affirmative checking action.
    if (/[?？「」『』"“”]/u.test(sentence)) continue;
    for (const match of sentence.matchAll(availabilityCheck)) {
      const tail = sentence.slice(match.index! + match[0].length);
      if (/^(?:必要|予定|日時|日程|時刻|期限|方法|か|とは|という)/u.test(tail)) continue;
      for (const kind of materialKinds(match[1])) checked.add(kind);
    }
  }
  return checked;
}

function hasUnqualifiedAvailability(outcome: string, checked: Set<string>): boolean {
  for (const sentence of outcome.match(/[^。！？!?\r\n]+[。！？!?]?/gu) ?? []) {
    // Preserve quoted, conditional and interrogative outcomes conservatively.
    // This is cross-field consistency checking, not general entailment parsing.
    if (/[?？「」『』"“”]/u.test(sentence)) continue;
    for (const match of sentence.matchAll(availabilityClaim)) {
      if (![...materialKinds(match[1])].some((kind) => checked.has(kind))) continue;
      const before = sentence.slice(0, match.index);
      const after = sentence.slice(match.index! + match[0].length);
      if (/場合|なら|れば|とき|際には/u.test(before)) continue;
      if (/^(?:性|か|場合|なら|のであれば|とすれば|とき|際|とは|わけでは|では|と(?:断定|判断|確認)|という(?:根拠|事実|こと)|根拠|事実|こと(?:は|が))/u.test(after)) continue;
      if (/^(?:な|の)?(?:範囲|内容|資料|事例|データ|もの)(?:の)?(?:有無|可否|は未確認|を(?:判断|確認|明確|整理|把握))/u.test(after)) continue;
      if (/^ようになるか|^ように(?:は)?な(?:らない|りません)/u.test(after)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Bounded Japanese action/outcome consistency repair. An action that still
 * checks whether materials exist cannot establish their positive availability
 * in its outcome. Only explicitly linked material nouns are considered; dates,
 * preparation tasks and other kinds of checks do not activate the guard.
 * Keep raw inputs immutable and audit the changed action indexes separately.
 */
export function constrainActionOutcomes<T extends ActionOutcomes>(actions: T): {
  value: T; applied: boolean; changedIndexes: number[];
} {
  const changedIndexes: number[] = [];
  const nextActions = actions.next_actions.map((entry, index) => {
    if (typeof entry?.action !== "string" || typeof entry?.expected_outcome !== "string") return entry;
    const checked = checkedMaterials(entry.action.normalize("NFKC"));
    if (!checked.size || !hasUnqualifiedAvailability(entry.expected_outcome.normalize("NFKC"), checked)) return entry;
    changedIndexes.push(index);
    // The rest of this outcome can depend on the rejected availability claim.
    // Replace it as a whole; do not retain unsupported downstream benefits.
    const expectedOutcome = `${[...checked].join("・")}の有無と内容、顧客への提供可否を判断するための確認結果が整理される。`;
    return { ...entry, expected_outcome: expectedOutcome };
  });
  return {
    value: changedIndexes.length ? { ...actions, next_actions: nextActions } : actions,
    applied: changedIndexes.length > 0,
    changedIndexes,
  };
}
