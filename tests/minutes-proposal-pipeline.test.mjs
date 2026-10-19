import assert from "node:assert/strict";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";

async function setup() {
  const mocks = { prompts: [], heavyReply: null };
  const entry = "src/lib/ai/pipeline.ts";
  const pipeline = await offlineModule(entry, mocks, {
    "./anthropic": "export const callClaudeHeavyJSON=async p=>{mocks.prompts.push(p);return mocks.heavyReply};export const callClaudeJSON=async()=>null;export const tryParseJSON=JSON.parse;",
    "./provider": "export const hasAiTextKey=()=>false;",
  }, [entry, ...["fewshot", "bant-definitions", "bant-withdrawal", "bant-reconciliation", "timeline-evidence", "customer-conditions", "offer-evidence", "strategy-text", "minutes-proposal-evidence", "action-outcome", "issue-evidence", "need-evidence", "action-reason-evidence", "recommendation-source-references", "minutes-action-evidence", "minutes-participant-evidence", "causal-evidence"].map((name) => `src/lib/ai/${name}.ts`)]);
  return { pipeline, mocks };
}

const ctx = { companyName: "検証社", dealTitle: "原文にない企画", products: ["原文にない商材"], pastEdits: [{ aiOutput: "旧案", userEdit: "別の商材を提案する" }] };
const draft = (proposals) => ({ participants: ["営業", "顧客"], issue_source_ids: [], proposals, next_actions: [], decisions: [], summary: "情報交換を実施。" });

test("minutes publish grounded strings and retain rejected/raw proposal candidates only in audit and trace", async () => {
  const { pipeline, mocks } = await setup();
  const question = "質問は担当者間で共有されていますか。";
  const option = "動画を使ってみてはいかがでしょうか。";
  const proposals = [{ text: "質問を共有する", source_quote: question, speech_act: "offered_option" }, { text: "動画を導入する", source_quote: option, speech_act: "offered_option" }];
  const parsed = draft(proposals);
  const before = structuredClone(parsed);
  mocks.heavyReply = { parsed, usedFallback: false };
  const result = await pipeline.runPipeline(`営業：${question}\n営業：${option}`, ctx);
  const minutes = result.meetingMinutes;
  assert.deepEqual(Array.from(minutes.json.proposals), [`営業側の検討案：${option}`]);
  assert.doesNotMatch(minutes.markdown, /source_quote|speech_act|factual_question|質問を共有する|動画を導入する/);
  assert.deepEqual(parsed, before);
  assert.equal(minutes.proposalAudit.candidates, proposals);
  assert.equal(minutes.proposalAudit.rejected[0].reason, "factual_question");
  assert.equal(result.trace.find((row) => row.step === "t05_meeting_minutes").output.proposalAudit, minutes.proposalAudit);
  assert.equal(mocks.prompts.length, 1);
  assert.equal(mocks.prompts[0].maxTokens, 3000);
  assert.match(mocks.prompts[0].system, /source_quote/);
  assert.doesNotMatch(mocks.prompts[0].user, /原文にない商材|原文にない企画|別の商材/);
  assert.equal(minutes.promptVersion, "20261001-transcript-only-v14");
  assert.match(mocks.prompts[0].system, /提案後の発言も確認/);
});

test("real-provider legacy proposals cannot bypass grounding while local fallback stays compatible", async () => {
  const { pipeline, mocks } = await setup();
  const text = "営業：動画をご提案します。";
  mocks.heavyReply = { parsed: draft(["動画をご提案します。"]), usedFallback: false };
  const provider = await pipeline.generateMeetingMinutes(text, ctx);
  assert.deepEqual(Array.from(provider.json.proposals), []);
  assert.equal(provider.proposalAudit.rejected[0].reason, "legacy_string_without_source");
  mocks.heavyReply = null;
  const fallback = await pipeline.generateMeetingMinutes(text, ctx);
  assert.deepEqual(Array.from(fallback.json.proposals), [text]);
  assert.equal(fallback.usedFallback, true);
  assert.equal(fallback.proposalAudit, undefined);
});

test("later budget corrections stay in the minutes audit without rewriting old proposals into current offers", async () => {
  const { pipeline, mocks } = await setup();
  const quote = "80万円を仮の目安として、内容を整理しましょう。";
  const correction = "顧客：先ほどの80万円という目安は訂正します。現在の目安は120万円です。";
  const candidates = [{ text: "120万円で内容を整理する", source_quote: quote, speech_act: "offered_option" }];
  mocks.heavyReply = { parsed: draft(candidates), usedFallback: false };
  const result = await pipeline.runPipeline(`営業：${quote}\n${correction}`, ctx);
  const minutes = result.meetingMinutes;
  assert.deepEqual(Array.from(minutes.json.proposals), []);
  assert.doesNotMatch(minutes.markdown, /営業側の検討案|80万円|120万円で内容を整理する|later_source_quote/);
  assert.equal(minutes.proposalAudit.candidates, candidates);
  assert.equal(minutes.proposalAudit.rejected[0].later_source_quote, correction);
  assert.equal(result.trace.find((row) => row.step === "t05_meeting_minutes").output.proposalAudit, minutes.proposalAudit);
  assert.equal(mocks.prompts.length, 1);
  assert.equal(mocks.prompts[0].maxTokens, 3000);
});

test("minutes project complete issue source turns instead of generated actor and scope changes", async () => {
  const { pipeline, mocks } = await setup();
  const actor = "顧客：私が気にしているのは、学生に会社をよく見せることだけではありません。普通の働き方も伝えたいです。";
  const objects = "顧客：採用サイトと案内メールはあります。メールには仕事内容の詳しい文章があまりありません。職場を撮影した素材は手元にありません。既存の紹介動画があるかは把握していません。";
  const transcript = `検証用の会話\n\n営業：課題を教えてください。\n${actor}\n${objects}`;
  const requested = [3, 4];
  const parsed = { ...draft([]), issue_source_ids: requested,
    customer_issues: ["学生が会社をよく見せたい", "採用サイトとメールに仕事内容の情報が不足している", "素材と動画の有無は未確認"] };
  const before = structuredClone(parsed);
  mocks.heavyReply = { parsed, usedFallback: false };
  const result = await pipeline.runPipeline(transcript, ctx);
  const minutes = result.meetingMinutes;
  assert.deepEqual(Array.from(minutes.json.customer_issues), [actor, objects].map((turn) => turn.replace(/^顧客：/u, "")));
  assert.doesNotMatch(minutes.markdown, /学生が会社をよく見せたい|採用サイトとメールに仕事内容の情報が不足|素材と動画の有無は未確認|issue_source_ids|requestedSourceIds/);
  assert.deepEqual(parsed, before);
  assert.equal(minutes.issueAudit.requestedSourceIds, requested);
  assert.equal(minutes.issueAudit.accepted[0].sourceText, actor);
  assert.equal(result.trace.find((row) => row.step === "t05_meeting_minutes").output.issueAudit, minutes.issueAudit);
  assert.equal(minutes.json.issue_source_ids, undefined);
  const prompt = mocks.prompts[0];
  const sourceTurns = JSON.parse(prompt.user.match(/# 文字起こし[^\n]*\n([\s\S]*)\n\nJSONのみ/u)[1]);
  assert.deepEqual(sourceTurns, transcript.split(/\r?\n/u).filter((line) => line.trim()).map((text, index) => ({ id: index + 1, text })));
  assert.match(prompt.system, /issue_source_ids/);
  assert.equal(prompt.maxTokens, 3000);
  assert.equal(mocks.prompts.length, 1);
});

test("missing or rejected real-provider issue references never fall back to generated issue paraphrases", async () => {
  const { pipeline, mocks } = await setup();
  const transcript = "営業：応募数不足が課題ですか？\n顧客：どのような情報が必要ですか？";
  const legacy = { ...draft([]), customer_issues: ["応募数不足が課題"] };
  delete legacy.issue_source_ids;
  mocks.heavyReply = { parsed: legacy, usedFallback: false };
  const missing = await pipeline.generateMeetingMinutes(transcript, ctx);
  assert.deepEqual(Array.from(missing.json.customer_issues), []);
  assert.equal(missing.issueAudit.rejected[0].reason, "invalid_source_ids");
  mocks.heavyReply = { parsed: { ...legacy, issue_source_ids: [1, 2, 99] }, usedFallback: false };
  const rejected = await pipeline.generateMeetingMinutes(transcript, ctx);
  assert.deepEqual(Array.from(rejected.json.customer_issues), []);
  assert.deepEqual(Array.from(rejected.issueAudit.rejected, (row) => row.reason), ["seller_turn", "question_only", "invalid_source_id"]);
  mocks.heavyReply = null;
  const fallback = await pipeline.generateMeetingMinutes("顧客：応募数不足が課題です。", ctx);
  assert.deepEqual(Array.from(fallback.json.customer_issues), ["顧客：応募数不足が課題です。"]);
  assert.equal(fallback.issueAudit, undefined);
});


test("minutes use expressed actions literally and cannot upgrade a future opportunity wish",async()=>{
 const {pipeline,mocks}=await setup();
 const wish="またお話しできればと思います。";
 const intention="仕事内容を学生にどう伝えるか、改めて社内でも話してみたいと思います。";
 const confirmed="9月30日までに資料を送付します。";
 const candidates=[
  {action:"社内での検討内容を話す機会を設ける",owner:"営業",due:"未確認",source_quote:wish},
  {action:"社内で仕事内容を学生にどう伝えるか話す",owner:"営業",due:"明日",source_quote:intention},
  {action:"資料送付",owner:"顧客",due:"9月30日",source_quote:confirmed},
 ];
 mocks.heavyReply={parsed:{...draft([]),next_actions:candidates},usedFallback:false};
 const before=JSON.stringify(candidates);
 const run=await pipeline.runPipeline(`営業：${wish}\n顧客：${intention}\n営業：${confirmed}`,ctx);
 const result=run.meetingMinutes;
 assert.deepEqual(Array.from(result.json.next_actions,a=>({...a})),[
  {action:intention,owner:"顧客",due:"未確認"},
  {action:confirmed,owner:"営業",due:"9月30日"},
 ]);
 assert.equal(JSON.stringify(candidates),before);
 assert.equal(result.actionAudit.candidates,candidates);
 assert.equal(run.trace.find(t=>t.step==="t05_meeting_minutes").output.actionAudit,result.actionAudit);
 assert.doesNotMatch(result.markdown,/機会を設ける|source_quote|明日/);
 assert.equal(mocks.prompts.length,1);assert.equal(mocks.prompts[0].maxTokens,3000);
});

// MX-02（2026-10-01）: 「次回は11月5日の10時に…よろしいですか」「はい、…大丈夫です」の2行に分かれた合意が決定事項に入らなかった。
test("minutes keep a two-turn proposal-and-acceptance agreement as a decision and state that rule in the prompt", async () => {
  const { pipeline, mocks } = await setup();
  const transcript = [
    "話者1: 次回は11月5日の10時にこちらからお伺いしてもよろしいですか。",
    "話者2: はい、11月5日の10時で大丈夫です。",
  ].join("\n");
  const decision = "次回は11月5日10時に訪問することで合意した";
  mocks.heavyReply = { parsed: { ...draft([]), decisions: [decision] }, usedFallback: false };
  const minutes = await pipeline.generateMeetingMinutes(transcript, ctx);
  assert.deepEqual(Array.from(minutes.json.decisions), [decision]);
  assert.match(minutes.markdown, /11月5日10時に訪問することで合意/);
  const { system } = mocks.prompts[0];
  assert.match(system, /2つの発言に分かれていても双方の合意/);
  assert.match(system, /話者1」「話者2」/);
  // 承諾のない提示・保留は決定事項にしない（緩めない）。
  assert.match(system, /承諾の返答がない提示、「検討します」「確認して連絡します」などの保留/);
  assert.equal(minutes.promptVersion, "20261001-transcript-only-v14");
});

test("minutes drop budget/timing/authority-only issue turns but keep real issues; the prompt says so", async () => {
  const { pipeline, mocks } = await setup();
  const transcript = [
    "営業：制作予算は決まっていますか？",
    "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。",
    "顧客：導入はまだ決めていませんが、導入するなら2027年4月を希望します。正式な時期は未確定です。",
    "顧客：説明会後に一次面接へ進む学生が少ないことが課題です。",
  ].join("\n");
  mocks.heavyReply = { parsed: { ...draft([]), issue_source_ids: [2, 3, 4] }, usedFallback: false };
  const minutes = await pipeline.generateMeetingMinutes(transcript, ctx);
  assert.deepEqual(Array.from(minutes.json.customer_issues), ["説明会後に一次面接へ進む学生が少ないことが課題です。"]);
  assert.equal(JSON.stringify(minutes.issueAudit.rejected.map(({ sourceId, reason }) => [sourceId, reason])), JSON.stringify([[2, "bant_only"], [3, "bant_only"]]));
  const { system } = mocks.prompts[0];
  assert.match(system, /予算・承認状況、導入時期・日程、決裁者・承認経路/);
  // 要約で金額・時刻・提出物を落とさない（C2・C7）。
  assert.match(system, /金額・日付・時刻・期限・提出物/);
});
