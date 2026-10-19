import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

function fixture() {
  return {
    id: "offline-deal", title: "架空サンプル製菓の採用動画", status: "PROPOSAL",
    bant: {
      budget: "予算80万円を目安にする。",
      authority: "窓口は人事担当。最終的には管理部門を担当する取締役が決裁する。",
      need: "新卒採用への応募数不足", timeline: "2027年3月希望",
      manualFields: { budget: true, authority: true, need: true, timeline: true },
      items: { authority: { value: "古い役員", status: "confirmed", quote: "User edited this BANT field manually." } },
      aiSuggestion: { authority: { value: "OLD_SUGGESTION_MUST_NOT_BE_USED" } },
      confidence: 100, summary: "OLD_SUMMARY_MUST_NOT_BE_USED",
    },
    company: { name: "架空サンプル製菓株式会社", industry: "菓子製造", employeeCount: null, websiteSummary: "社内未検証要約" },
    products: [{ productName: "採用動画", planName: null, planProposals: [], yomiStatus: null, amount: null }],
    meetings: [{
      title: "第6回商談", meetingDate: new Date("2026-09-23T06:30:00Z"),
      transcript: "予算80万円です。最終決裁者は人事部長の山田さんです。新卒採用への応募数不足が課題です。2027年3月希望です。",
      minutes: "旧要約では取締役とされている。",
      bantBudget: "80万円", bantAuthority: "人事部長の山田さん", bantNeed: "新卒採用への応募数不足", bantTimeline: "2027年3月希望",
    }],
  };
}

const rawOutput = {
  industry_summary: "確認できず", sources: [],
  hiring_insights: { media: "確認できず", roles: "確認できず", scale: "確認できず", sources: [] },
  pain_hypotheses: [],
  proposal_story: "# つかみ\n社内商談記録を確認します。\n\n# 課題共感\n採用課題を確認します。\n\n# 商材提案\n採用動画を候補にします。\n\n# 効果イメージ\n応募前理解を助ける仮説です。\n\n# 確認論点\n公開情報では対象会社を確認できず。",
};

async function load(deal = fixture(), contextText = "# 商材カタログ\n- 採用動画", output = rawOutput) {
  const state = { deal, contextText, output, prompts: [], writes: 0 };
  const api = await offlineModule("src/lib/ai/preparation.ts", state, {
    "./vertex-grounding": "export const vertexPreparation=async(name,prompt)=>{mocks.prompts.push({name,prompt});return {parsed:mocks.output,grounding:{sources:[]},model:'offline-model'}};export const preparationFormattingWorstCaseBytes=()=>0;",
    "@/lib/ai/anthropic": "export const callClaudeHeavyJSONWithTools=()=>{throw Error('AI forbidden')};export const formatAnthropicDebug=()=>'';export const getAnthropicModelName=()=>'';",
    "@/lib/ai/provider": "export const getHeavyTextProvider=()=> 'vertex';export const hasAnthropicKey=()=>false;",
    "@/lib/ai/luma-context": "export const formatLumaContextForPrompt=x=>x;export const getLumaContextText=async()=>mocks.contextText;",
    "@/lib/db": "export const prisma={deal:{findUnique:async()=>mocks.deal,update:()=>{mocks.writes++;throw Error('DB writes forbidden')}}};",
  }, ["src/lib/ai/preparation.ts", "src/lib/ai/bant-definitions.ts", "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/vertex-policy.ts"]);
  return { api, state };
}

const contextFormatter = await offlineModule("src/lib/ai/luma-context.ts", {}, {
  "@/lib/db": "export const prisma=new Proxy({}, {get(){throw Error('DB access forbidden')}});",
  "@/lib/tenant-context": "export const currentTenant=()=>undefined;export const getRequestTenant=async()=>null;",
}, ["src/lib/ai/luma-context.ts", "src/lib/ai/luma-value-proposition.ts"]);
const emptyCatalogContext = contextFormatter.formatLumaContextText({ products: [], proposals: [] });

test("T09 empty formatted catalog never treats shared usage rules or examples as registered products", async () => {
  const { api } = await load();
  assert.match(emptyCatalogContext, /商材名・プラン名・企画型は/);
  assert.match(emptyCatalogContext, /商材マスタ未登録/);
  assert.equal(api.extractLumaProductNamesFromContext(emptyCatalogContext).length, 0);
});

test("T09 catalog extraction accepts catalog rows and plans but excludes descriptions, placeholders and other sections", async () => {
  const { api } = await load();
  const context = contextFormatter.formatLumaContextText({
    products: [
      { name: "映像制作", description: "指示ではない商材説明", plans: [{ name: "採用動画", basePrice: 800000 }] },
      { name: "SNS支援", plans: [] },
    ],
    proposals: [{ name: "社員インタビュー" }],
    dealProducts: [{ productName: "案件だけの商材", planName: "案件プラン" }],
    valueProposition: "- 提供価値の説明は商品名ではない",
  });
  const names = Array.from(api.extractLumaProductNamesFromContext(context));
  assert.deepEqual(new Set(names), new Set(["映像制作", "採用動画", "SNS支援", "社員インタビュー"]));
  assert.doesNotMatch(names.join("\n"), /プラン未登録|案件だけの商材|指示ではない|提供価値|使う|基準価格/);
  const boundary = "- 見出し前の説明\n# 商材カタログ\n- 採用動画 / 説明\n  - プラン未登録\n# 説明\n- ここは商材でない\n## 例\n- 架空商品例\n# 企画型一覧\n- 社員インタビュー\n# 別の節\n- 別の説明";
  assert.deepEqual(Array.from(api.extractLumaProductNamesFromContext(boundary)), ["採用動画", "社員インタビュー"]);
});

test("T09 unregistered offerings replace generated product and effect claims with confirmation text", async () => {
  const { api } = await load();
  const story = "# つかみ\n社内の課題を確認します。\n\n# 商材提案\n架空パッケージを提供します。\n\n# 効果イメージ\n架空パッケージで応募が倍増します。\n\n# 確認論点\n次回の予定を確認します。";
  const output = api.normalizeProposalStory({ story, catalogProductNames: [], dealProductNames: [] });
  assert.match(output, /# 商材提案\n提案できる商材・プランが未登録/);
  assert.match(output, /# 効果イメージ\n提供可能な商材が未確認/);
  assert.doesNotMatch(output, /架空パッケージ|応募が倍増|映像制作|SNS運用|ドラマ風動画|undefined/);
  assert.match(output, /社内の課題を確認します/);
  assert.match(output, /次回の予定を確認します/);
  for (const heading of api.PROPOSAL_STORY_HEADINGS) assert.ok(output.includes(`# ${heading}\n`));
  assert.equal(api.normalizeProposalStory({ story: output }), output);
});

test("T09 offline fallback does not invent default offerings when no catalog or deal product exists", async () => {
  const { api } = await load();
  const brief = api.fallbackPreparationBrief("架空検証会社");
  assert.match(brief.proposal_story, /商材・プランが未登録/);
  assert.match(brief.proposal_story, /提供可能な商材が未確認/);
  assert.doesNotMatch(brief.proposal_story, /映像制作|SNS運用|ドラマ風動画|を候補にします|商材名・プラン名・企画型は/);
  assert.equal(brief.sources.length, 0);
});

test("T09 a registered deal product remains usable without a catalog and authored matching text is preserved", async () => {
  const { api } = await load();
  const output = api.normalizeProposalStory({ story: rawOutput.proposal_story, dealProductNames: ["採用動画"], catalogProductNames: [] });
  assert.equal(output, rawOutput.proposal_story);
  const fallback = api.fallbackPreparationBrief("架空検証会社", { dealProductNames: ["採用動画"] });
  assert.match(fallback.proposal_story, /採用動画を候補にします/);
  assert.doesNotMatch(fallback.proposal_story, /商材・プランが未登録/);
});

test("T09 prompt uses only the current registered-name list, including an explicit empty-catalog rule", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.products = [];
  const emptyPrompt = api.buildPreparationResearchPrompt(deal, emptyCatalogContext);
  assert.match(emptyPrompt.system, /Registered names for this request are \[\]/);
  assert.match(emptyPrompt.system, /Usage rules, example sentences, and general service descriptions are not catalog registrations/);
  assert.match(emptyPrompt.system, /If the registered-name list is empty/);
  assert.doesNotMatch(emptyPrompt.system, /The current catalog names are/);
  deal.products = [{ productName: "映像制作", planName: "採用動画", planProposals: ["社員インタビュー"], yomiStatus: null, amount: null }];
  const withDeal = api.buildPreparationResearchPrompt(deal, emptyCatalogContext);
  assert.ok(withDeal.system.includes('Registered names for this request are ["映像制作","採用動画","社員インタビュー"]'));
});

test("T09 empty-catalog generation never prepends a shared instruction as a product name", async () => {
  const deal = fixture();
  deal.products = [];
  const before = structuredClone(deal);
  const { api, state } = await load(deal, emptyCatalogContext);
  const result = await api.generatePreparationResearch(deal.id);
  assert.match(result.brief.proposal_story, /商材・プランが未登録/);
  assert.doesNotMatch(result.brief.proposal_story, /商材名・プラン名・企画型は|ここに無い商品名を作らない|を候補にします/);
  assert.match(result.brief.proposal_story, /社内記録の確認：決裁者・承認経路/);
  assert.equal(result.fallback, false);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.writes, 0);
  assert.deepEqual(deal, before);
});

test("T09 separates public research from dated internal sources and omits copied manual certainty", async () => {
  const { api } = await load();
  const deal = fixture(), before = structuredClone(deal);
  const prompt = api.buildPreparationResearchPrompt(deal, "# Catalog\n- 採用動画");
  assert.match(prompt.system, /If it cannot be identified, stop public research/);
  assert.match(prompt.system, /do not substitute similarly named companies, expand into other industries/);
  assert.match(prompt.system, /Internal records are not public research/);
  assert.match(prompt.system, /do not invent a URL for them/);
  assert.match(prompt.system, /Use the newest explicit customer statement first/);
  assert.match(prompt.system, /Compare the meaning, subject, conditions, and scope of manual BANT and the latest explicit meeting statement/);
  assert.match(prompt.system, /Paraphrases, summaries, added detail, different metrics/);
  assert.match(prompt.system, /Do not downgrade both records to unconfirmed merely because their wording differs/);
  assert.doesNotMatch(prompt.system, /Where manual BANT and the latest explicit meeting statement differ/);
  assert.match(prompt.system, /Missing information is not a contradiction/);
  assert.match(prompt.user, /manual_bant_reference/);
  assert.match(prompt.user, /Internal record comparisons \(wording differences alone do not prove a conflict\)/);
  assert.doesNotMatch(prompt.user, /Internal record differences to confirm/);
  assert.match(prompt.user, /人事部長の山田さん/);
  assert.match(prompt.user, /2026\/9\/23/);
  assert.doesNotMatch(prompt.user, /User edited this BANT field manually|OLD_SUGGESTION|OLD_SUMMARY|"confirmed"|"confidence"/);
  assert.deepEqual(deal, before);
});

const neutralComparison = "記録の関係（要約・補足、対象や条件の違い、更新）は、この比較だけでは判断できません。";
const forcedConflict = /記載の相違は未解決|どちらも現時点の確定事項とはせず/;

test("T09 appends literal latest decision-maker evidence without mechanically declaring a conflict", async () => {
  const { api } = await load();
  const deal = fixture(), reviews = api.preparationInternalReviews(deal);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].key, "authority");
  assert.equal(reviews[0].sourceType, "transcript");
  assert.equal(reviews[0].quote, "最終決裁者は人事部長の山田さんです");
  assert.ok(deal.meetings[0].transcript.includes(reviews[0].quote));
  const output = api.normalizePreparationOutput(rawOutput, { companyName: deal.company.name, internalReviews: reviews });
  const confirmation = output.proposal_story.split("# 確認論点\n")[1];
  assert.match(confirmation, /手動BANT（入力時点不明）/);
  assert.match(confirmation, /管理部門を担当する取締役/);
  assert.match(confirmation, /第6回商談（2026\/9\/23）の文字起こし原文/);
  assert.match(confirmation, /人事部長の山田さん/);
  assert.ok(confirmation.includes(neutralComparison));
  assert.doesNotMatch(confirmation, forcedConflict);
  assert.match(confirmation, /最終決裁者と窓口・承認者の役割分担を確認する/);
  assert.equal(output.sources.length, 0);
  assert.equal(output.hiring_insights.sources.length, 0);
});

test("T09 detailed hiring-funnel notes and a short applicant-shortage statement remain neutral comparisons", async () => {
  const deal = fixture();
  deal.bant.need = "新卒採用は年間8名を目標としているが、昨年度の入社は5名。求人サイトから一定数の応募はあるものの、会社説明会への参加や、その後の選考につながりにくいことが課題。採用サイトは文章と設備写真が中心で、学生からは入社後の仕事を想像しにくいと言われる。仕事内容と若手社員の雰囲気、入社後の研修・相談体制を伝えたい。応募数だけでなく、説明会から選考への移行率も確認したい。ただし現在の移行率や辞退理由は整理できておらず、次回までに採用実績を共有してもらう予定。";
  deal.meetings[0].bantNeed = "新卒採用の応募数不足";
  deal.meetings[0].transcript = "課題は新卒採用の応募数不足です。";
  const before = structuredClone(deal);
  const { api, state } = await load(deal);
  const result = await api.generatePreparationResearch(deal.id);
  const story = result.brief.proposal_story;
  assert.match(story, /【社内記録の確認：課題】/);
  assert.ok(story.includes(deal.bant.need));
  assert.ok(story.includes("文字起こし原文には「課題は新卒採用の応募数不足です」"));
  assert.ok(story.includes(neutralComparison));
  assert.match(story, /今回優先する課題と、過去メモにある補足情報の関係を確認する。/);
  assert.doesNotMatch(story, forcedConflict);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.writes, 0);
  assert.deepEqual(deal, before);
});

test("T09 summary wording and supplemental need details are not treated as proof that either record is invalid", async () => {
  const { api } = await load();
  const pairs = [
    ["新卒採用へのエントリーを増やしたい。仕事内容の説明を分かりやすくしたい。", "応募数の改善", "採用の課題は応募数の改善です。"],
    ["説明会への参加者を増やしたい。", "選考参加率の改善", "採用の課題は選考参加率の改善です。"],
  ];
  for (const [manual, latest, transcript] of pairs) {
    const deal = fixture();
    deal.bant.need = manual;
    deal.meetings[0].bantNeed = latest;
    deal.meetings[0].transcript = transcript;
    const before = structuredClone(deal);
    const reviews = api.preparationInternalReviews(deal);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].key, "need");
    assert.equal(reviews[0].quote, transcript.replace(/。$/u, ""));
    const story = api.normalizeProposalStory({ story: rawOutput.proposal_story, internalReviews: reviews, dealProductNames: ["採用動画"] });
    assert.ok(story.includes(neutralComparison));
    assert.match(story, /今回優先する課題と、過去メモにある補足情報の関係を確認する。/);
    assert.doesNotMatch(story, forcedConflict);
    assert.deepEqual(deal, before);
  }
});

test("T09 a budget target and an upper limit retain their scopes without a forced conflict", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.bant.budget = "制作予算の目安は80万円（税別）。";
  deal.meetings[0].bantBudget = "上限100万円";
  deal.meetings[0].transcript = "予算は上限100万円で、内容を見て調整します。";
  const before = structuredClone(deal);
  const reviews = api.preparationInternalReviews(deal);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].key, "budget");
  const story = api.normalizeProposalStory({ internalReviews: reviews, dealProductNames: ["採用動画"] });
  assert.ok(story.includes(deal.bant.budget));
  assert.ok(story.includes("予算は上限100万円で、内容を見て調整します"));
  assert.ok(story.includes(neutralComparison));
  assert.match(story, /同じ対象・条件を指すか、現在の合意内容を確認する。/);
  assert.doesNotMatch(story, forcedConflict);
  assert.deepEqual(deal, before);
});

test("T09 a contact and a final approver prompt role clarification without invalidating either role", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.bant.authority = "日程調整の窓口は人事担当の佐藤さん。";
  deal.meetings[0].transcript = "最終決裁者は人事部長の山田さんです。";
  const before = structuredClone(deal);
  const reviews = api.preparationInternalReviews(deal);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].key, "authority");
  const story = api.normalizeProposalStory({ internalReviews: reviews, dealProductNames: ["採用動画"] });
  assert.ok(story.includes(deal.bant.authority));
  assert.ok(story.includes("最終決裁者は人事部長の山田さんです"));
  assert.ok(story.includes(neutralComparison));
  assert.match(story, /最終決裁者と窓口・承認者の役割分担を確認する。/);
  assert.doesNotMatch(story, forcedConflict);
  assert.deepEqual(deal, before);
});

test("T09 recognizes spaced ASR decision-maker wording while preserving the original quote", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.meetings[0].transcript = "話者1: は 80万円 です 。 決済 者 は 人事 部 長 の 山田 さん です 。 課題 は 新卒 採用 の 応募 数 不足 です 。 2027 年 3 月 に 採用 動画 を 公開 し たい です 。";
  deal.meetings[0].bantAuthority = "人事部長の山田さん";
  const reviews = api.preparationInternalReviews(deal);
  const authority = reviews.find((review) => review.key === "authority");
  assert.ok(authority);
  assert.equal(authority.sourceType, "transcript");
  assert.equal(authority.quote, "決済 者 は 人事 部 長 の 山田 さん です");
  assert.ok(deal.meetings[0].transcript.includes(authority.quote));
  const output = api.normalizePreparationOutput(rawOutput, { internalReviews: reviews });
  assert.match(output.proposal_story, /文字起こし原文には「決済 者 は 人事 部 長 の 山田 さん です」/);
});

test("T09 missing or unknown latest evidence does not manufacture a difference", async () => {
  const { api } = await load();
  for (const overrides of [
    { bantAuthority: null },
    { bantAuthority: "未確認: 決裁者への言及なし" },
    { transcript: "今回は録音テストだけです。", minutes: "決裁者は役員。" },
    { transcript: "決裁者は未確認です。", minutes: "決裁者は役員。" },
    { transcript: "", minutes: "" },
  ]) {
    const deal = fixture();
    Object.assign(deal.meetings[0], overrides);
    assert.equal(api.preparationInternalReviews(deal).length, 0);
  }
});

test("T09 an incorrect generated BANT value cannot fabricate a difference from unchanged primary evidence", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.bant.budget = "30万円";
  deal.bant.authority = "総務部長の佐藤さん";
  deal.meetings[0].transcript = "予算は30万円です。最終決裁者は総務部長の佐藤さんです。";
  deal.meetings[0].minutes = "誤った要約：予算は80万円、決裁者は人事部長の山田さん。";
  // Secondary generated fields are wrong; the primary transcript agrees with manual BANT.
  deal.meetings[0].bantBudget = "80万円";
  deal.meetings[0].bantAuthority = "人事部長の山田さん";
  assert.equal(api.preparationInternalReviews(deal).length, 0);
});

test("T09 a longer generated phrase that already contains the manual value is not a new difference", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.bant.budget = "80万円";
  deal.bant.authority = "人事部長の山田さん";
  deal.meetings[0].bantBudget = "予算80万円";
  deal.meetings[0].bantAuthority = "最終決裁者は人事部長の山田さん";
  assert.equal(api.preparationInternalReviews(deal).length, 0);
});

test("T09 uses latest date and does not treat an older mention as a new conflicting statement", async () => {
  const { api } = await load();
  const deal = fixture();
  const older = deal.meetings[0];
  deal.meetings.push({ ...older, title: "第7回商談", meetingDate: new Date("2026-09-24T00:00:00Z"), transcript: "日程だけを相談しました。", bantAuthority: "未確認" });
  const before = [...deal.meetings];
  assert.equal(api.preparationInternalReviews(deal).length, 0);
  assert.deepEqual(deal.meetings, before);
  const prompt = api.buildPreparationResearchPrompt(deal, "# Catalog\n- 採用動画");
  assert.ok(prompt.user.indexOf("## 第7回商談") < prompt.user.indexOf("## 第6回商談"));
});

test("T09 distinguishes minutes-only evidence without inventing a transcript citation", async () => {
  const { api } = await load();
  const deal = fixture();
  deal.meetings[0].transcript = null;
  deal.meetings[0].minutes = "決裁者は人事部長の山田さんです。";
  const reviews = api.preparationInternalReviews(deal);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].sourceType, "minutes");
  const output = api.normalizePreparationOutput(rawOutput, { internalReviews: reviews });
  assert.match(output.proposal_story, /議事録（文字起こしなし）/);
  assert.doesNotMatch(output.proposal_story, /文字起こし原文/);
});

test("T09 matching or nonmanual values do not create conflict topics", async () => {
  const { api } = await load();
  const equal = fixture();
  equal.bant.authority = "人事部長の山田さん";
  assert.equal(api.preparationInternalReviews(equal).length, 0);
  const automatic = fixture();
  automatic.bant.manualFields.authority = false;
  assert.equal(api.preparationInternalReviews(automatic).length, 0);
  const unknown = fixture();
  unknown.bant.authority = "未確認";
  assert.equal(api.preparationInternalReviews(unknown).length, 0);
});

test("T09 normalizer preserves authored story wording and only adds explicit review context", async () => {
  const { api } = await load();
  const reviews = api.preparationInternalReviews(fixture());
  const output = api.normalizePreparationOutput(rawOutput, { internalReviews: reviews, dealProductNames: ["採用動画"] });
  assert.equal(output.proposal_story.split("# 確認論点")[0], rawOutput.proposal_story.split("# 確認論点")[0]);
  const again = api.normalizePreparationOutput(output, { internalReviews: reviews, dealProductNames: ["採用動画"] });
  assert.equal(again.proposal_story, output.proposal_story);
});

test("T09 generation passes internal reviews through mocked Vertex flow without changing manual BANT", async () => {
  const deal = fixture(), before = structuredClone(deal);
  Object.freeze(deal.bant);
  const { api, state } = await load(deal);
  const result = await api.generatePreparationResearch(deal.id);
  assert.match(result.brief.proposal_story, /社内記録の確認：決裁者・承認経路/);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.writes, 0);
  assert.deepEqual(deal, before);
});

// Excerpt of the saved real output of revision 00011-7lr (fictional demo tenant, empty catalog):
// .verification/cloud-development/preparation-quality-result.json generated.proposalStory.
const recordedGreeting = "架空準備検証f5ab7907株式会社様の人事部長、山田様。本日は新卒採用における貴社の課題解決に向けたご提案の機会をいただき、誠にありがとうございます。";
const recordedGreetingOffer = "貴社の新卒採用目標達成に貢献できるよう、Lumaが持つ映像制作のノウハウを最大限に活用し、魅力的な採用動画の企画をご提案させていただきます。";
const recordedEmpathy = "貴社では新卒採用において年間8名の目標に対し、昨年度の入社が5名であったとのこと、また、求人サイトからの応募はあっても説明会への参加や選考への移行が課題となっていると伺っております。特に「新卒採用への応募数不足」が喫緊の課題であると認識しております。応募者の方々が貴社の若手社員の雰囲気や入社後の研修・相談体制について、より具体的にイメージできる機会が不足しているのかもしれません。";
const recordedEmpathyOffer = "Lumaは、こうした応募前の理解促進に特化した採用動画制作を通じて、貴社の採用活動を強力にサポートいたします。";
const recordedConfirmation = "いくつか確認させてください。\n\n1.  予算について、旧メモでは30万円とありましたが、今回の商談で「予算80万円で採用動画を制作します」と伺いました。この80万円という予算で、どのようなコンテンツを制作されたいか、具体的なイメージがあればお聞かせいただけますでしょうか。\n2.  決裁者について、旧メモでは総務部長の佐藤様とありましたが、今回の商談で「決裁者は人事部長の山田です」と伺いました。最終的な承認プロセスについて、改めて確認させていただけますでしょうか。";
const recordedStory = [
  `# つかみ\n${recordedGreeting}${recordedGreetingOffer}`,
  `# 課題共感\n${recordedEmpathy}${recordedEmpathyOffer}`,
  "# 商材提案\n提案できる商材・プランが未登録のため、具体的な商材提案は保留します。提供可能な商材と正式名称を確認してください。",
  "# 効果イメージ\n提供可能な商材が未確認のため、具体的な効果の説明は保留します。商材の内容と顧客の課題を確認したうえで、効果仮説を整理します。",
  `# 確認論点\n${recordedConfirmation}`,
].join("\n\n");
const recordedCompany = "架空準備検証f5ab7907株式会社";

function storySection(story, heading) {
  return story.split(`# ${heading}\n`)[1].split(/\n\n# /u)[0];
}

test("T18 unregistered offerings drop the recorded seller offers from the greeting and empathy sections", async () => {
  const { api } = await load();
  const output = api.normalizeProposalStory({ story: recordedStory, companyName: recordedCompany, catalogProductNames: [], dealProductNames: [] });
  assert.equal(storySection(output, "つかみ"), recordedGreeting);
  assert.equal(storySection(output, "課題共感"), recordedEmpathy);
  assert.ok(!output.includes(recordedGreetingOffer));
  assert.ok(!output.includes(recordedEmpathyOffer));
  assert.doesNotMatch(output, /ご提案させていただきます|強力にサポートいたします/);
  assert.equal(storySection(output, "確認論点"), recordedConfirmation);
  assert.match(output, /# 商材提案\n提案できる商材・プランが未登録/);
  assert.match(output, /# 効果イメージ\n提供可能な商材が未確認/);
  assert.equal(api.normalizeProposalStory({ story: output, companyName: recordedCompany, catalogProductNames: [], dealProductNames: [] }), output);
});

test("T18 the mocked Vertex flow with an empty catalog applies the seller-offer removal", async () => {
  const deal = fixture();
  deal.products = [];
  const before = structuredClone(deal);
  const { api, state } = await load(deal, emptyCatalogContext, { ...rawOutput, proposal_story: recordedStory });
  const result = await api.generatePreparationResearch(deal.id);
  const story = result.brief.proposal_story;
  assert.equal(storySection(story, "つかみ"), recordedGreeting);
  assert.equal(storySection(story, "課題共感"), recordedEmpathy);
  assert.ok(storySection(story, "確認論点").startsWith(recordedConfirmation));
  assert.match(story, /社内記録の確認：決裁者・承認経路/);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.writes, 0);
  assert.deepEqual(deal, before);
});

test("T18 registered offerings keep authored greeting and empathy wording unchanged", async () => {
  const { api } = await load();
  for (const registered of [{ dealProductNames: ["採用動画"], catalogProductNames: [] }, { dealProductNames: [], catalogProductNames: ["採用動画"] }]) {
    const output = api.normalizeProposalStory({ story: recordedStory, companyName: recordedCompany, ...registered });
    assert.equal(storySection(output, "つかみ"), `${recordedGreeting}${recordedGreetingOffer}`);
    assert.equal(storySection(output, "課題共感"), `${recordedEmpathy}${recordedEmpathyOffer}`);
    assert.equal(storySection(output, "確認論点"), recordedConfirmation);
    assert.equal(api.normalizeProposalStory({ story: output, companyName: recordedCompany, ...registered }), output);
  }
});

test("T18 removal keeps hold/confirmation wording and customer quotes, falls back to defaults, and leaves 確認論点 alone", async () => {
  const { api } = await load();
  const options = { companyName: "架空検証会社", catalogProductNames: [], dealProductNames: [] };
  const defaults = api.normalizeProposalStory(options);
  const story = [
    "# つかみ\nLumaが採用動画の制作をご提案します。\n- 弊社は貴社の採用広報を支援いたします。",
    "# 課題共感\n私どもがお手伝いできる内容は未登録のため、提供範囲を確認します。当社は説明会の改善に貢献します。「Lumaさんに採用動画の制作を提案してほしい」と伺いました。",
    "# 確認論点\n弊社として提案できる範囲を整理します。",
  ].join("\n\n");
  const output = api.normalizeProposalStory({ story, ...options });
  assert.equal(storySection(output, "つかみ"), storySection(defaults, "つかみ"));
  assert.equal(storySection(output, "課題共感"), "私どもがお手伝いできる内容は未登録のため、提供範囲を確認します。「Lumaさんに採用動画の制作を提案してほしい」と伺いました。");
  assert.equal(storySection(output, "確認論点"), "弊社として提案できる範囲を整理します。");
  assert.equal(api.normalizeProposalStory({ story, ...options, dealProductNames: ["採用動画"] }).includes("当社は説明会の改善に貢献します。"), true);
  const empathyOnlyOffers = api.normalizeProposalStory({ story: "# 課題共感\nLumaは貴社の採用活動を強力にサポートいたします。", ...options });
  assert.equal(storySection(empathyOnlyOffers, "課題共感"), storySection(defaults, "課題共感"));
  assert.equal(api.normalizeProposalStory({ story: output, ...options }), output);
  assert.equal(api.normalizeProposalStory({ story: empathyOnlyOffers, ...options }), empathyOnlyOffers);
});

test("T18 customer quotes and non-subject seller mentions are kept whole while seller-subject offers are still dropped", async () => {
  const { api } = await load();
  const options = { companyName: "架空検証会社", catalogProductNames: [], dealProductNames: [] };
  const defaults = api.normalizeProposalStory(options);
  // Customers call their own company 弊社/当社 in quoted speech, with or without 。 inside the brackets.
  const customerEvidence = [
    "先方からは「弊社では若手社員の雰囲気を伝える動画制作を考えています。」と伺いました。採用人数の目標は8名です。",
    "人事部長は「弊社は説明会の参加率改善を実現したい」と話しており、応募前の理解促進が課題です。",
    "山田様は『当社は採用広報の支援を受けたい。』と話されました。",
    "山田様はLumaの過去事例に関心を示しており、採用動画の制作を検討されています。",
    "LumaFlow社の提供するサービスを利用中。",
  ];
  for (const sentence of customerEvidence) {
    const output = api.normalizeProposalStory({ story: `# つかみ\n${sentence}\n\n# 課題共感\n${sentence}`, ...options });
    assert.equal(storySection(output, "つかみ"), sentence);
    assert.equal(storySection(output, "課題共感"), sentence);
    assert.equal(api.normalizeProposalStory({ story: output, ...options }), output);
  }

  const mixed = [
    "# つかみ",
    "山田様から「弊社は動画制作を検討中です。」と伺いました。「採用動画」について、弊社は制作を支援します。",
    "LumaFlow社の提供するサービスを利用中です。株式会社Lumaが採用動画をご提案します。",
    "",
    "# 課題共感",
    "『当社で説明会の改善を実現したい』とのことです。貴社の課題に対し、Luma社は採用動画の制作を支援します。",
  ].join("\n");
  const output = api.normalizeProposalStory({ story: mixed, ...options });
  assert.equal(storySection(output, "つかみ"), "山田様から「弊社は動画制作を検討中です。」と伺いました。\nLumaFlow社の提供するサービスを利用中です。");
  assert.equal(storySection(output, "課題共感"), "『当社で説明会の改善を実現したい』とのことです。");
  assert.doesNotMatch(output, /弊社は制作を支援します|ご提案します|Luma社は/);
  assert.equal(api.normalizeProposalStory({ story: output, ...options }), output);
  // A registered offering leaves the same story untouched.
  const registered = api.normalizeProposalStory({ story: mixed, ...options, dealProductNames: ["採用動画"] });
  assert.match(registered, /弊社は制作を支援します。/);
  assert.notEqual(storySection(output, "つかみ"), storySection(defaults, "つかみ"));
});

test("T18 seller mentions in customer-subject sentences are kept and only the seller's own non-past offer predicate is dropped", async () => {
  const { api } = await load();
  const options = { companyName: "架空検証会社", catalogProductNames: [], dealProductNames: [] };
  const defaults = api.normalizeProposalStory(options);
  const kept = [
    // Review repro (a)-(d): the seller is not the subject, or its verb is a noun, past or attributive form.
    "Lumaの過去事例に山田様が関心を示しており、採用動画の制作を検討されています。",
    "弊社の担当者が伺った際、先方から採用動画制作のご相談をいただきました。",
    "山田様は、以前Lumaが制作した他社の採用動画をご覧になり、関心を持たれました。",
    "山田様は弊社が提案した動画制作プランに前向きなご意見をくださいました。",
    // A seller token without a subject particle is not an offer by the seller, even at the sentence start.
    "Lumaの映像制作ノウハウで貴社を支援します。",
    // Attributive forms, questions, and reported customer statements stay.
    "Lumaが制作する動画の方向性は、先方で決める予定です。",
    "Lumaが採用動画を制作できますかというご質問がありました。",
    "山田様は、当社は内製で制作できますが企画力が足りないと話されました。",
    "弊社が伺ったところ、先方は動画を内製で制作します。",
    // Review repro: a polite question, the brief's own 貴社では after the seller, and reported speech without 様.
    "Lumaが採用動画を制作できますでしょうかというご質問がありました。",
    "弊社が伺ったところ、貴社では来期から採用動画を内製で制作します。",
    "人事部長は、当社は内製で制作できますが企画力が足りないと話されました。",
    // A customer's reported desire stays even though a desiderative ending now counts as a seller offer.
    "山田様は、当社は採用動画を内製で制作したいと話されました。",
    // Precision first: a named customer person anywhere keeps the sentence, even inside a seller offer.
    "弊社は、山田様が重視されている応募前理解を支援します。",
  ];
  for (const sentence of kept) {
    const output = api.normalizeProposalStory({ story: `# つかみ\n${sentence}\n\n# 課題共感\n${sentence}`, ...options });
    assert.equal(storySection(output, "つかみ"), sentence);
    assert.equal(storySection(output, "課題共感"), sentence);
    assert.equal(api.normalizeProposalStory({ story: output, ...options }), output);
  }

  // Review repro: a mid-sentence "Luma社は" is the seller, and so is "Luma株式会社が".
  const dropped = [
    "貴社の課題に対し、Luma社は採用動画の制作を支援します。",
    "Luma株式会社が採用動画の企画をご提案いたします。",
    "- 私たちは貴社の採用広報をお手伝いします。",
    "弊社は応募前の理解促進を支援する",
    // Review repro: soft and desiderative offer endings are seller offers.
    "Lumaは、貴社の採用課題解決に貢献できると確信しております。",
    "弊社では、採用動画を通じて貴社の課題解決をお手伝いできればと考えております。",
    "弊社は、貴社の採用活動をご支援させていただきたいと考えております。",
    "Lumaとして、応募前理解を深める採用動画の制作をご提案したいと考えています。",
    "Luma株式会社では、採用動画の企画から制作までワンストップでご提供可能です。",
    // Review repro: a form of address is not a customer reference.
    "貴社様が抱える課題に対し、Lumaは採用動画の制作をご支援いたします。",
    "応募者の皆様が貴社の魅力を理解できるよう、Lumaが採用動画の制作をご支援いたします。",
    // 貴社が after the seller subject in a relative clause does not make the customer the subject either.
    "Luma社は、貴社が抱える採用課題の解決を支援いたします。",
  ];
  for (const sentence of dropped) {
    const output = api.normalizeProposalStory({ story: `# つかみ\n${sentence}\n\n# 課題共感\n${sentence}`, ...options });
    assert.equal(storySection(output, "つかみ"), storySection(defaults, "つかみ"));
    assert.equal(storySection(output, "課題共感"), storySection(defaults, "課題共感"));
    const registered = api.normalizeProposalStory({ story: `# つかみ\n${sentence}`, ...options, dealProductNames: ["採用動画"] });
    assert.equal(storySection(registered, "つかみ"), sentence);
  }
});

test("T18 customer quotes in curly and straight double quotes are kept whole like 「」 quotes", async () => {
  const { api } = await load();
  const options = { companyName: "架空検証会社", catalogProductNames: [], dealProductNames: [] };
  const quoted = [
    // Review repro: the customer's own 弊社 inside “…”.
    "先方からは“弊社では動画制作を考えています”と伺いました。",
    // The quoted wording would read as a seller offer outside the quotes, and 。 inside the quotes does not split the sentence.
    "人事部長は“弊社は動画を内製で制作します。”と話されました。",
    "人事部長は\"当社が社員インタビューを制作できます。\"と話されました。",
    // Review repro: reversed curly quotes ”…” and double prime quotes 〝…〟.
    "”弊社では動画を内製で制作します”と伺いました。",
    "〝弊社では動画を内製で制作します〟と伺いました。",
  ];
  for (const sentence of quoted) {
    const output = api.normalizeProposalStory({ story: `# つかみ\n${sentence}\n\n# 課題共感\n${sentence}`, ...options });
    assert.equal(storySection(output, "つかみ"), sentence);
    assert.equal(storySection(output, "課題共感"), sentence);
    assert.equal(api.normalizeProposalStory({ story: output, ...options }), output);
  }

  const mixed = "# つかみ\n人事部長は“弊社は動画を内製で制作します。”と話されました。Luma社は編集を支援します。\n\n# 課題共感\n\"当社で制作できます。\"とのことです。弊社は撮影を支援いたします。";
  const output = api.normalizeProposalStory({ story: mixed, ...options });
  assert.equal(storySection(output, "つかみ"), "人事部長は“弊社は動画を内製で制作します。”と話されました。");
  assert.equal(storySection(output, "課題共感"), "\"当社で制作できます。\"とのことです。");
  assert.equal(api.normalizeProposalStory({ story: output, ...options }), output);

  // 。 inside ”…” or 〝…〟 does not split the sentence, and a 〟 after 。 is removed with the seller's sentence.
  const moreQuotes = "# つかみ\n先方は”弊社は動画を内製で制作します。”と話されました。Luma社は編集を支援します。\n\n# 課題共感\n〝当社で制作できます。〟とのことです。弊社は撮影を支援いたします。〟山田様の関心は採用広報です。";
  const moreOutput = api.normalizeProposalStory({ story: moreQuotes, ...options });
  assert.equal(storySection(moreOutput, "つかみ"), "先方は”弊社は動画を内製で制作します。”と話されました。");
  assert.equal(storySection(moreOutput, "課題共感"), "〝当社で制作できます。〟とのことです。山田様の関心は採用広報です。");
  assert.equal(api.normalizeProposalStory({ story: moreOutput, ...options }), moreOutput);
});

// Every example raised in the three T18 review rounds. The filter is precision-first: a sentence that mentions
// the customer, a named person or reported speech is kept even when it also contains a seller offer; those
// remaining seller offers are left to the T18 prompt/model review rather than risking deleted customer evidence.
const reviewCorpus = {
  dropped: [
    "Lumaは、貴社の採用課題解決に貢献できると確信しております。",
    "弊社では、採用動画を通じて貴社の課題解決をお手伝いできればと考えております。",
    "弊社は、貴社の採用活動をご支援させていただきたいと考えております。",
    "Lumaとして、応募前理解を深める採用動画の制作をご提案したいと考えています。",
    "Luma株式会社では、採用動画の企画から制作までワンストップでご提供可能です。",
    "Lumaは、貴社が採用目標を達成できるよう、採用動画の制作をご支援いたします。",
    "弊社は、貴社がより多くの応募者と出会えるよう、採用動画の制作を支援いたします。",
    "Lumaは、貴社では初となる採用動画の制作をご提案いたします。",
    "弊社は、貴社も含めた多くの企業の採用動画制作を支援いたします。",
    "Lumaは、貴社が求めるような採用動画の制作をご支援いたします。",
    "弊社としては、採用動画の企画をご提案させていただきたく存じます。",
    "Lumaは、貴社の採用活動をサポートさせていただきたく存じます。",
    "Lumaは、貴社の採用活動をご支援いたしたいと考えております。",
    "弊社は、採用動画の企画をご提案申し上げたく存じます。",
    "Lumaは、貴社の採用活動に伴走していきたいと考えております。",
    "弊社は、貴社の採用活動をご支援してまいりたいと考えております。",
    "弊社では、企画から撮影・編集まで一貫してご支援することが可能です。",
    "Lumaでは、採用動画の企画から制作まで一貫してご提供することができます。",
    "Lumaは、企画から撮影・編集までワンストップでの制作が可能です。",
    "弊社では、採用動画の企画から制作まで一貫したご支援が可能です。",
    "Lumaは、貴社の採用課題の解決に貢献できると思います。",
    "弊社は、貴社の採用課題の解決に貢献できるものと確信しております。",
    "弊社は、多くの企業様で実績のある採用動画の制作をご支援いたします。",
    "Lumaは、同業の企業様からもご好評いただいている採用動画の制作をご提案いたします。",
    "応募者の皆様が貴社の魅力を理解できるよう、Lumaが採用動画の制作をご支援いたします。",
    "貴社の課題に対し、Luma社は採用動画の制作を支援します。",
  ],
  kept: [
    // Customer statements and reported desires (they must never be deleted).
    "人事部長は、当社も採用動画を内製で制作したいとのご意向でした。",
    "当社は採用動画を内製で制作したいという要望がありました。",
    "当社は採用動画を内製で制作したいと山田様がおっしゃっていました。",
    "当社は採用動画を内製で制作したいと人事部長がおっしゃっていました。",
    "当社も採用動画を内製で制作したいと、人事部長から伺いました。",
    "当社は採用動画を内製で制作したいそうです。",
    "人事部長は、当社が制作できればコストを抑えられるとお考えです。",
    "弊社が伺ったところ、貴社では来期から採用動画を内製で制作します。",
    "人事部長は、当社は内製で制作できますが企画力が足りないと話されました。",
    "Lumaが採用動画を制作できますでしょうかというご質問がありました。",
    "LumaFlow社の提供するサービスを利用中。",
    "山田様はLumaの過去事例に関心を示しており、採用動画の制作を検討されています。",
    // Documented precision-first misses: seller offers that mention a customer person or a conversation.
    "山田様が抱える課題に対し、Lumaは採用動画の制作をご支援いたします。",
    "山田様が懸念されている定着率について、弊社は採用動画での改善をご提案いたします。",
    "Lumaが採用動画の企画をご提案いたしますので、改めてご担当者様とお話しする機会をいただければ幸いです。",
    "弊社は採用動画の制作を支援いたしますので、人事部の方と話を進めさせてください。",
  ],
};

test("T18 review corpus: clear seller offers are dropped; customer statements and ambiguous sentences are kept", async () => {
  const { api } = await load();
  const options = { companyName: "架空検証会社", catalogProductNames: [], dealProductNames: [] };
  const defaults = api.normalizeProposalStory(options);
  for (const sentence of reviewCorpus.dropped) {
    const output = api.normalizeProposalStory({ story: `# つかみ\n${sentence}\n\n# 課題共感\n${sentence}`, ...options });
    assert.equal(storySection(output, "つかみ"), storySection(defaults, "つかみ"), sentence);
    assert.equal(storySection(output, "課題共感"), storySection(defaults, "課題共感"), sentence);
  }
  for (const sentence of reviewCorpus.kept) {
    const output = api.normalizeProposalStory({ story: `# つかみ\n${sentence}\n\n# 課題共感\n${sentence}`, ...options });
    assert.equal(storySection(output, "つかみ"), sentence, sentence);
    assert.equal(storySection(output, "課題共感"), sentence, sentence);
  }
  // A ”…” quote that starts right after 。 belongs to the next sentence, not to the previous one.
  const story = "# つかみ\n山田様の関心は採用広報です。”当社は動画を内製で制作します”という方針です。Luma社は撮影を支援します。";
  const output = api.normalizeProposalStory({ story, ...options });
  assert.equal(storySection(output, "つかみ"), "山田様の関心は採用広報です。”当社は動画を内製で制作します”という方針です。");
});
