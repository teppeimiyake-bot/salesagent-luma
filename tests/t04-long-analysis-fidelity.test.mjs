// T04/T22: 長い記録の原文抜粋が、後段の決定論的な根拠補正（撤回の判定・時期の根拠・課題の原文引用）で
// 原文と同じ結果になること。実物の判定モジュールに、原文と抜粋の両方を渡して比べる。AI・DB は使わない。
import test from "node:test";
import assert from "node:assert/strict";
import longTranscript from "../src/lib/ai/long-transcript.ts";
import bantWithdrawal from "../src/lib/ai/bant-withdrawal.ts";
import timelineEvidence from "../src/lib/ai/timeline-evidence.ts";
import issueEvidence from "../src/lib/ai/issue-evidence.ts";
import customerConditions from "../src/lib/ai/customer-conditions.ts";
import causalEvidence from "../src/lib/ai/causal-evidence.ts";

const {
  analysisUnits, buildCondensedSource, guardSelections, lineUnitRanges, planLongChunks, rebuildCondensedSource, renderUnits,
  exceedsLongAnalysisLimit, LONG_LINE_UNIT_CHARS, LONG_ANALYSIS_MAX_SOURCE_TURNS_JSON_BYTES,
} = longTranscript;
const { findBantWithdrawal } = bantWithdrawal;
const { groundTimeline, timelineSourceTurns } = timelineEvidence;
const { readSourceEvidenceBlocks } = issueEvidence;
const { constrainUnagreedSubmissionDeadline } = customerConditions;
const { constrainUnverifiedCausalRecommendations } = causalEvidence;

/** 営業・顧客が交互に話す、根拠補正の対象にならない架空の発言。 */
const filler = (from, count) => Array.from({ length: count }, (_, i) => `${(from + i) % 2 ? "営業" : "顧客"}：議題${from + i}について、現在の運用と入力の手間、それから現場での確認手順を順番に説明します。`);
const idOf = (text, line) => analysisUnits(text).find(unit => unit.text === line).id;
const excerptIdOf = (excerpt, line) => timelineSourceTurns(excerpt).find(turn => turn.text === line)?.id;
const condense = (source, lines, topics, target) => {
  const selections = lines.map(line => ({ id: idOf(source, line), topics }));
  return buildCondensedSource(source, selections, planLongChunks(source), target);
};

test("T04 excerpt fidelity: a withdrawal, the lines between and the present-unknown stay one customer block, so the withdrawal applies as on the original", () => {
  const withdrawal = "顧客：前回お伝えした予算500万円と来年4月の導入希望は撤回します。";
  const middle = "顧客：実は先週、担当役員が交代しまして、方針が変わりました。";
  const unknown = "顧客：現在のところ、社内では予算と導入時期は未定です。";
  const source = [
    ...filler(1, 40), "顧客：予算は500万円です。", "顧客：導入は来年4月を希望しています。",
    "営業：承知しました。予算500万円を目安として、採用動画3本の制作をおすすめします。",
    ...filler(44, 60), "営業：本日の最後に確認させてください。", withdrawal, middle, unknown, ...filler(107, 40),
  ].join("\n");
  // The model picks only the two guard-worthy lines; the middle line has no guard word and is not picked.
  const { text } = condense(source, [withdrawal, unknown], ["change"]);
  const lines = text.split("\n");
  assert.equal(lines[lines.indexOf(withdrawal) + 1], middle, "the middle line of the same customer block is kept, with no blank line");
  assert.equal(lines[lines.indexOf(withdrawal) + 2], unknown);
  for (const key of ["budget", "timeline"]) {
    assert.ok(findBantWithdrawal(source, key), `original ${key} withdrawal`);
    assert.deepEqual(findBantWithdrawal(text, key), findBantWithdrawal(source, key), `excerpt ${key} withdrawal`);
  }
});

test("T04 excerpt fidelity: a later replacement after a withdrawal is always kept, so the withdrawal is cancelled as on the original", () => {
  const replacement = "顧客：その後、役員と相談しまして、新しい導入時期は2027年10月を予定しています。";
  const source = [
    ...filler(1, 30), "顧客：前回お伝えした2027年4月の導入希望は撤回します。現在、導入時期は未定です。",
    ...filler(33, 30), replacement, ...filler(64, 30),
  ].join("\n");
  assert.equal(findBantWithdrawal(source, "timeline"), null, "the original is not withdrawn (replaced later)");
  // No model selection at all: guards alone must carry both the withdrawal and the replacement.
  const { text } = buildCondensedSource(source, [], planLongChunks(source));
  assert.ok(text.includes(replacement));
  assert.equal(findBantWithdrawal(text, "timeline"), null);
});

test("T04 excerpt fidelity: a date keeps the condition in the next line of the same speaker, and conditions rank with dates when trimming", () => {
  const date = "顧客：導入は2027年4月を目標にしています。";
  const condition = "顧客：ただ、それは補助金の採択が前提で、採択されなければ翌年度になります。";
  const source = [...filler(1, 50), "営業：導入の時期はいつ頃でしょうか。", date, condition, ...filler(54, 50)].join("\n");
  const { text } = condense(source, [date], ["timeline"]);
  const original = groundTimeline(source, [idOf(source, date)]);
  const excerpt = groundTimeline(text, [excerptIdOf(text, date)]);
  assert.deepEqual(excerpt.sourceQuotes, original.sourceQuotes);
  assert.ok(original.sourceQuotes.includes(condition));
  // A condition line in its own block is not dropped before plain needs of the same excerpt.
  const needs = filler(200, 120).map((line, i) => (i % 2 ? line : line.replace("について", "が課題です。について")));
  const conditional = "営業：もし補助金が通れば、そのときは導入の前倒しも検討できます。";
  const trimmed = [conditional, ...needs].join("\n");
  const kept = buildCondensedSource(trimmed, [
    { id: 1, topics: ["condition"] },
    ...needs.map((_, i) => ({ id: i + 2, topics: ["need"] })),
  ], planLongChunks(trimmed), 3_000);
  assert.ok(kept.sourceLineIds.includes(1), "the (oldest) condition outranks later needs");
  assert.ok(kept.droppedForBudget > 0);
});

test("T04 excerpt fidelity: an unlabeled continuation line keeps its speaker label, so a seller's hypothesis is not published as a customer issue", () => {
  const head = "営業：少し整理させてください。";
  const continuation = "御社の課題は、面接の日程調整に時間がかかり辞退が増えていることだと理解しています。";
  const source = [...filler(1, 30), "顧客：現在、応募者の管理は表計算で行っています。", head, continuation, ...filler(34, 30)].join("\n");
  const { text } = condense(source, [continuation], ["need"]);
  const lines = text.split("\n");
  assert.equal(lines[lines.indexOf(continuation) - 1], head);
  const block = [...readSourceEvidenceBlocks(text).values()].find(item => item.body.includes("御社の課題"));
  assert.equal(block.speaker, "営業");
  assert.equal(block.sourceRole, "seller");
});

test("T04 excerpt trimming: lines the guards read are never dropped; AI-picked corrections go oldest first so closing ones survive", () => {
  // Every line states a present unknown: all are must-keep, so the excerpt keeps them even over the target.
  const unknowns = Array.from({ length: 60 }, (_, i) => `顧客：第${i}の論点の予算は未確認です。`);
  const kept = buildCondensedSource(unknowns.join("\n"), [], planLongChunks(unknowns.join("\n")), 2_000);
  for (const line of unknowns) assert.ok(kept.text.includes(line));
  assert.ok(kept.mustKeepBytes > 2_000 && kept.condensedTurnsJsonBytes > 2_000);
  assert.equal(kept.droppedForBudget, 0);
  // Lines without guard words that the model marked as changes are trimmed oldest first.
  const changes = Array.from({ length: 200 }, (_, i) => `顧客：第${i}の論点は、前回から方針を切り替えることにしました。`);
  const closing = "顧客：最終確認です。95万円は訂正前の数字として扱ってください。";
  const source = [...changes, closing].join("\n");
  const result = buildCondensedSource(source, changes.map((_, i) => ({ id: i + 1, topics: ["change"] })), planLongChunks(source), 4_000);
  assert.ok(result.text.includes(closing), "the must-keep correction is kept");
  assert.ok(result.text.includes(changes.at(-1)), "the latest AI-picked change is kept");
  assert.ok(!result.text.includes("第0の論点"), "the oldest AI-picked change goes first");
  assert.ok(result.guardDropped > 0 && result.guardDropped === result.droppedForBudget);
  assert.ok(result.condensedTurnsJsonBytes <= 4_000);
});

test("T04 excerpt tiers: generic words (見積・承認・期限…) do not crowd out the AI's budget, timeline and need picks", () => {
  const generic = i => [
    `営業：第${i}の案件の見積も、まとめてお出しすることができます。`,
    `営業：第${i}の資料は、次回までにご用意いたします。`,
    `顧客：第${i}の進め方は、部長の承認をもらってから決めます。`,
  ][i % 3];
  const lines = Array.from({ length: 700 }, (_, i) => (i % 5 === 0 ? generic(i) : filler(i, 1)[0]));
  const need = "顧客：一番困っているのは、説明会の後に一次面接へ進む学生が少ないことです。";
  const budget = "顧客：制作費は300万円を上限に考えています。";
  const timeline = "顧客：導入は来年4月を希望しています。";
  lines[100] = need; lines[300] = budget; lines[500] = timeline;
  const source = lines.join("\n");
  const result = buildCondensedSource(source, [
    { id: 101, topics: ["need"] }, { id: 301, topics: ["budget"] }, { id: 501, topics: ["timeline"] },
  ], planLongChunks(source));
  for (const line of [need, budget, timeline]) assert.ok(result.text.includes(line), `lost: ${line}`);
  assert.ok(result.condensedTurnsJsonBytes <= 22_000);
  assert.ok(result.droppedForBudget > 0, "generic lines were trimmed instead");
});

test("T04 excerpt runs over the cap: seeds in one long run are joined by the lines between them, and a label far above is kept", () => {
  const withdrawal = "顧客：前回お伝えした予算500万円と来年4月の導入希望は撤回します。";
  const unknown = "顧客：現在のところ、社内では予算と導入時期は未定です。";
  const story = Array.from({ length: 30 }, (_, i) => `顧客：経緯の説明の${i}つ目として、社内の体制が大きく変わった事情をお話しします。`);
  const run = [...story.slice(0, 10), withdrawal, ...story.slice(10, 13), unknown, ...story.slice(13)];
  const source = [...filler(1, 20), "営業：これまでの経緯を教えてください。", ...run, "営業：ありがとうございました。", ...filler(60, 20)].join("\n");
  assert.ok(Buffer.byteLength(run.join("\n")) > 3_000, "one customer run over the whole-run cap");
  const { text } = buildCondensedSource(source, [], planLongChunks(source));
  const lines = text.split("\n");
  const from = lines.indexOf(withdrawal);
  assert.deepEqual(lines.slice(from, from + 5), [withdrawal, ...story.slice(10, 13), unknown], "no blank line inside the block");
  for (const key of ["budget", "timeline"]) {
    const original = findBantWithdrawal(source, key);
    const excerpt = findBantWithdrawal(text, key);
    assert.ok(original && excerpt, `${key} withdrawal detected on both`);
    assert.equal(excerpt.value, original.value);
    assert.ok(source.includes(excerpt.quote), "the audit quote is a verbatim part of the original block");
  }
  // A seller's long explanation: the hypothesis 3 unlabeled lines below the label keeps the seller label.
  const explanation = Array.from({ length: 40 }, (_, i) => `続けて、第${i}の論点について弊社の考え方を順番にご説明します。`);
  explanation[3] = "御社の課題は、面接の日程調整に時間がかかり辞退が増えていることだと理解しています。";
  const seller = [...filler(1, 10), "営業：それでは弊社から説明します。", ...explanation, ...filler(60, 10)].join("\n");
  const picked = idOf(seller, explanation[3]);
  const excerpt = buildCondensedSource(seller, [{ id: picked, topics: ["need"] }], planLongChunks(seller)).text;
  const block = [...readSourceEvidenceBlocks(excerpt).values()].find(item => item.body.includes("御社の課題"));
  assert.equal(block.speaker, "営業");
  assert.equal(block.sourceRole, "seller");
});

test("T04 excerpt runs over the cap: a date and its caveat a few lines later in one speaker's monologue stay one block", () => {
  const monologue = Array.from({ length: 22 }, (_, i) => `話者2: 社内の事情の説明の${i}つ目として、採用計画の見直しの経緯をお話しします。`);
  const date = "話者2: 導入は2027年4月を目標にしています。";
  const caveat = "話者2: ただし、役員会の承認が下りた場合の話で、まだ確定ではありません。";
  monologue[8] = date;
  monologue[12] = caveat;
  const source = [...filler(1, 20).map(line => line.replace(/^(営業|顧客)：/u, "話者1: ")), ...monologue, "話者1: 承知しました。", ...filler(40, 20).map(line => line.replace(/^(営業|顧客)：/u, "話者1: "))].join("\n");
  const { text } = condense(source, [date], ["timeline"]);
  assert.ok(!text.includes(monologue[0]), "the monologue is over the whole-run cap, so only windows are included");
  const original = groundTimeline(source, [idOf(source, date)]);
  const excerpt = groundTimeline(text, [excerptIdOf(text, date)]);
  assert.ok(original.sourceQuotes.includes(caveat), "the original Timeline keeps the caveat");
  assert.ok(excerpt.sourceQuotes.includes(caveat), "so does the excerpt's");
});

test("T04 excerpt long lines: a piece is never emitted without its speaker label, and the next sentence stays with it", () => {
  const sentences = Array.from({ length: 90 }, (_, i) => `弊社から第${i}の制作手順を、撮影と編集の順にご説明します。`);
  sentences[20] = "御社の導入時期は2027年4月を想定して、制作の段取りを組んでいきます。";
  sentences[21] = "ただし、これは営業側の仮説です。";
  const paragraph = `営業：${sentences.join("")}`;
  const source = [...filler(1, 10), paragraph, ...filler(20, 10)].join("\n");
  const units = analysisUnits(source);
  const seedUnit = units.find(unit => unit.text.includes("2027年4月を想定"));
  const { text } = buildCondensedSource(source, [{ id: seedUnit.id, topics: ["timeline"] }], planLongChunks(source));
  assert.ok(Buffer.byteLength(paragraph) > 6_000, "longer than the per-line cap, so only a labelled prefix fits");
  const line = text.split("\n").find(item => item.includes("2027年4月を想定"));
  assert.ok(line.length < paragraph.length, "a prefix, not the whole paragraph");
  assert.ok(line.startsWith("営業："), "the seller label is kept");
  assert.ok(line.includes("ただし、これは営業側の仮説です。"), "the following caveat is kept");
  assert.ok(paragraph.startsWith(line), "a verbatim prefix of the original line");
});

test("T04 excerpt guards: the vocabulary the post-processing relies on is always kept", () => {
  const lines = [
    "顧客：説明会後に一次面接へ進む学生が少ないことが課題です。原因は調べていません。",
    "顧客：学生が辞退した理由の集計まではまだできていません。",
    "顧客：応募経路別の数字は分かりません。",
    "顧客：次回の面談日程はまだ確定していません。",
    "顧客：先ほどの95万円という目安は誤りでした。",
    "顧客：導入時期は現時点では不明です。",
    "顧客：担当者はまだ決まっていません。",
  ];
  const source = [...filler(1, 20), ...lines.flatMap(line => [line, "営業：承知しました。"])].join("\n");
  const guarded = new Set(guardSelections(source).map(guard => guard.id));
  for (const line of lines) assert.ok(guarded.has(idOf(source, line)), `not guarded: ${line}`);
});

test("T04 long lines: a paragraph per segment is split at sentence ends into verbatim pieces; the excerpt is never empty", () => {
  const sentence = i => `話者1による第${i}の説明で、現場の入力負荷と確認の手順について順番に話しています。`;
  const paragraphs = Array.from({ length: 9 }, (_, p) => `話者1: ${Array.from({ length: 60 }, (_, i) => sentence(p * 100 + i)).join("")}`);
  paragraphs[7] += "ただし予算は未定です。";
  const source = paragraphs.join("\n\n");
  const units = analysisUnits(source);
  assert.ok(units.every(unit => unit.text.length <= LONG_LINE_UNIT_CHARS));
  assert.equal(renderUnits(units, units.map(unit => unit.id)), source, "all pieces reproduce the original exactly");
  for (const paragraph of paragraphs) assert.equal(lineUnitRanges(paragraph).map(([a, b]) => paragraph.slice(a, b)).join(""), paragraph);
  const pick = units.filter((_, i) => i % 17 === 0).map(unit => ({ id: unit.id, topics: ["need"] }));
  const result = buildCondensedSource(source, pick, planLongChunks(source));
  assert.ok(result.text.trim().length > 0);
  assert.ok(result.text.includes("ただし予算は未定です。"), "the guard sentence at the end of a long paragraph is kept");
  for (const line of result.text.split("\n")) assert.ok(line === "" || paragraphs.some(paragraph => paragraph.includes(line)), "every excerpt line is a verbatim substring");
  assert.equal(rebuildCondensedSource(source, result.sourceLineIds), result.text);
  // A single line bigger than one extraction request is still extractable piece by piece.
  const oneLine = `顧客：${sentence(0).repeat(400)}`;
  assert.ok(planLongChunks(oneLine).length > 1);
});

test("T04 long analysis size limit: records beyond the long-analysis limit are refused up front; building an excerpt stays fast", () => {
  const huge = filler(1, 2_200).join("\n");
  assert.equal(exceedsLongAnalysisLimit(huge), true);
  assert.equal(exceedsLongAnalysisLimit(filler(1, 1_000).join("\n")), false);
  assert.ok(LONG_ANALYSIS_MAX_SOURCE_TURNS_JSON_BYTES >= 300_000);
  // Near the limit with many selections and guards, excerpt building is linear enough for one request.
  const near = filler(1, 1_800).map((line, i) => (i % 5 ? line : line.replace("説明します", "説明します。見積の話もしました"))).join("\n");
  const units = analysisUnits(near);
  const started = performance.now();
  const result = buildCondensedSource(near, units.filter(unit => unit.id % 2).map(unit => ({ id: unit.id, topics: ["need"] })), planLongChunks(near));
  const elapsed = performance.now() - started;
  assert.ok(result.condensedTurnsJsonBytes <= 22_000);
  assert.ok(elapsed < 2_000, `buildCondensedSource took ${Math.round(elapsed)} ms`);
});

test("T04 excerpt rendering: blocks adjacent in the original stay adjacent, others get one blank line, CRLF and blank lines are handled", () => {
  const source = ["営業：一行目です。", "", "顧客：予算は未定です。", "営業：三行目です。", "顧客：四行目です。"].join("\r\n");
  const units = analysisUnits(source);
  assert.equal(renderUnits(units, [2, 3]), "顧客：予算は未定です。\n営業：三行目です。");
  assert.equal(renderUnits(units, [1, 2]), "営業：一行目です。\n\n顧客：予算は未定です。", "a physical blank line becomes one separator");
  assert.equal(renderUnits(units, [1, 4]), "営業：一行目です。\n\n顧客：四行目です。");
  assert.equal(renderUnits(units, [99]), null);
});

test("T04 excerpt tier 0: only the customer lines the guards read are must-keep, and only the line itself (its block is removable)", () => {
  // Speaker-N lines are not read by the customer-only guards: they never become must-keep, so they cannot crowd out AI picks.
  const asr = Array.from({ length: 600 }, (_, i) => `話者${i % 2 + 1}: 第${i}の論点の予算と導入時期は、まだ未確定です。`).join("\n");
  assert.equal(buildCondensedSource(asr, [], planLongChunks(asr)).mustKeepBytes, 0);
  const decision = "話者1: 企画書と見積書は9月30日までに送付することで合意しました。";
  const withPick = [asr, decision].join("\n");
  const picked = buildCondensedSource(withPick, [{ id: idOf(withPick, decision), topics: ["decision"] }], planLongChunks(withPick));
  assert.ok(picked.text.includes(decision), "the AI decision survives many uncertainty lines");
  assert.equal(picked.aiDropped, 0);
  // A customer run of three lines where only the middle one is read by a guard: only that line is must-keep.
  const unknown = "顧客：現在のところ、社内では予算は未定です。";
  const run = ["顧客：弊社の状況を順にお話しします。", unknown, "顧客：以上が現状になります。"];
  const source = [...filler(1, 20), ...run, ...filler(30, 20)].join("\n");
  const result = buildCondensedSource(source, [], planLongChunks(source), 0);
  assert.ok(result.text.includes(unknown));
  assert.ok(!result.text.includes(run[0]) && !result.text.includes(run[2]), "the rest of the block is trimmed first");
  assert.ok(result.mustKeepBytes < Buffer.byteLength(run.join("\n")) + 200);
});

test("T04 excerpt gap fill: when the earlier seed of a long run is trimmed, no unlabeled continuation line is left without its label", () => {
  const para1 = ["営業：本日の提案内容を順にご説明します。", ...Array.from({ length: 12 }, (_, i) => `説明の補足${i}として、撮影と編集の流れと体制を詳しくご案内します。`)];
  const para2 = ["営業：続いてスケジュールについてです。", ...Array.from({ length: 12 }, (_, i) => `日程の補足${i}として、撮影日と公開日の候補を順番にご案内します。`)];
  para1[6] = "御社の課題は、説明会の後に一次面接へ進む学生が少ないことだと当社では理解しています。";
  const proposal = para1[3];
  const schedule = para2[4];
  const decisions = Array.from({ length: 120 }, (_, i) => `顧客：第${i}の議題は、社内で合意済みの進め方で進めます。`);
  const source = [...para1, ...para2, "顧客：承知しました。", ...decisions].join("\n");
  const selections = [
    { id: idOf(source, proposal), topics: ["proposal"] },
    // The later seed outranks everything else, so it stays while the earlier one is trimmed.
    { id: idOf(source, schedule), topics: ["change"] },
    ...decisions.map(line => ({ id: idOf(source, line), topics: ["decision"] })),
  ];
  const { text } = buildCondensedSource(source, selections, planLongChunks(source), 8_000);
  assert.ok(text.includes(schedule) && !text.includes(proposal), "precondition: the later seed stays, the earlier one is trimmed");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line && (i === 0 || lines[i - 1] === "") && (para1.includes(line) || para2.includes(line))) {
      assert.ok(line.startsWith("営業："), `a block starts with an unlabeled seller continuation: ${line}`);
    }
  });
  assert.ok(!text.includes(para1[6]) || text.includes(para1[0]), "the seller hypothesis never appears without its label line");
});

test("T04 excerpt latest-wins guards: the later agreement and the later confirmed cause are kept, so the guards decide as on the original", () => {
  const unagreed = "顧客：次回面談の日程も、資料の提出期限も未合意です。";
  const agreed = "顧客：はい、企画書と見積書は9月30日までに送っていただくことで合意します。";
  const uninvestigated = "顧客：説明会後に一次面接へ進む学生が少ないことが課題です。原因はまだ分析していません。";
  const verifiedCause = "顧客：一次面接へ進む学生が少ない理由は、先月のアンケートで確認しました。";
  const picks = Array.from({ length: 150 }, (_, i) => `営業：第${i}の論点について、社内で整理した進め方をご説明します。`);
  // Seller lines between the customer lines keep each one in its own block (no block window can carry another).
  const source = [...filler(1, 10), uninvestigated, "営業：承知しました。", ...picks.slice(0, 75), unagreed, "営業：承知しました。", ...picks.slice(75), "営業：資料はいつまでにお送りすればよいでしょうか。", agreed, "営業：ありがとうございます。", verifiedCause, "営業：承知しました。", ...filler(300, 10)].join("\n");
  const selections = picks.map(line => ({ id: idOf(source, line), topics: ["decision"] }));
  const { text } = buildCondensedSource(source, selections, planLongChunks(source), 6_000);
  for (const line of [unagreed, agreed, uninvestigated, verifiedCause]) assert.ok(text.includes(line), `kept: ${line}`);
  const actions = { next_actions: [{ action: "次回面談までに企画書と見積書を送付する", reason: "", expected_outcome: "" }] };
  assert.equal(constrainUnagreedSubmissionDeadline(text, actions).applied, constrainUnagreedSubmissionDeadline(source, actions).applied);
  const strategy = { strategy: "説明会後に一次面接へ進む学生が少ないのは、説明会の内容がその原因となっている。" };
  assert.equal(constrainUnverifiedCausalRecommendations(text, strategy).applied, constrainUnverifiedCausalRecommendations(source, strategy).applied);
});

test("T04 excerpt must-keep vocabulary follows the guards' own forms", () => {
  const lines = [
    "顧客：一次面接へ進む学生が少ない理由は、正直なところ分からなくて困っています。",
    "顧客：学生が辞退した理由は、これまで調べていなかったです。",
    "顧客：先ほどの95万円は120万円に変更します。",
    "顧客：予算については、社内の関係部署とも相談したうえで、上長の了解を得て、年間で300万円を上限にしています。",
    "顧客：一次面接へ進む学生が少ない理由は、先月のアンケートで確認しました。",
    "顧客：次回の面談の日程は、来週中に確定します。",
  ];
  const source = [...filler(1, 20), ...lines.flatMap(line => [line, "営業：承知しました。"])].join("\n");
  const keep = new Set(guardSelections(source).filter(guard => guard.topics.includes("keep")).map(guard => guard.id));
  for (const line of lines) assert.ok(keep.has(idOf(source, line)), `not must-keep: ${line}`);
});

test("T04 excerpt long customer line: a withdrawal early and the present unknown late in one long line are kept whole", () => {
  const body = Array.from({ length: 130 }, (_, i) => `経緯の${i}つ目として、社内の体制と進め方を順番にお話しします。`).join("");
  const line = `顧客：前回お伝えした予算500万円は撤回します。${body}現在、予算は未定です。`;
  assert.ok(line.length > 3_800);
  const source = [...filler(1, 10), line, ...filler(20, 10)].join("\n");
  const result = buildCondensedSource(source, [], planLongChunks(source));
  assert.ok(result.text.split("\n").includes(line), "the whole line is in the excerpt");
  assert.equal(result.mustKeepMissing, 0);
  assert.deepEqual(findBantWithdrawal(result.text, "budget")?.value, findBantWithdrawal(source, "budget")?.value);
  assert.ok(findBantWithdrawal(source, "budget"));
});

test("T04 excerpt CPU: a withdrawal followed by a customer line of densely listed dates stays fast", () => {
  const source = ["顧客：導入時期は撤回します。", `顧客：候補は${"1日と".repeat(20_000)}を希望します。`].join("\n");
  const started = performance.now();
  guardSelections(source);
  buildCondensedSource(source, [], planLongChunks(source));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `took ${Math.round(elapsed)} ms`);
});
