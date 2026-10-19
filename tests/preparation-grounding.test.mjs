import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

const groundingModule = await offlineModule("src/lib/ai/vertex-grounding.ts", {}, {
  "./vertex": "export const vertexGenerate=()=>{throw Error('Real AI forbidden')};",
  "./vertex-policy": "export class VertexError extends Error { constructor(code,message){super(message);this.code=code;} }export const VERTEX_MAX_INPUT_BYTES=65536;",
});
const { scopeGroundingToCompany, constrainVertexSources, vertexPreparation } = groundingModule;
const name = "検証製菓株式会社";
const source = { title: "検証製菓株式会社 企業情報", url: "https://company.example.test/about" };
const other = { title: "別会社", url: "https://other.example.test/about" };
const suggestions = "<div>Google Search suggestions remain unchanged</div>";
const grounded = (text, sources = [source], supports = [{ text, sourceIndices: [0] }]) => ({ text, sources, supports, searchHtml: suggestions });

test("company not found cannot be filled with cited similar companies or industry facts", () => {
  const text = "検証製菓株式会社を特定できませんでした。参考として別会社は食品サンプルを製造しています。";
  const result = scopeGroundingToCompany(name, grounded(text, [other]));
  assert.equal(result.companyMatch, "unconfirmed");
  assert.equal(result.sources.length, 0);
  assert.equal(result.supports.length, 0);
  assert.doesNotMatch(result.text, /食品サンプル/);
  assert.equal(result.searchHtml, suggestions);
  const output = constrainVertexSources({ industry_summary: "別会社の事業", sources: [other],
    hiring_insights: { media: "求人サイト", roles: "営業", scale: "10名", sources: [other] },
    pain_hypotheses: [{ confidence: "high", source_url: other.url }] }, result);
  assert.equal(output.industry_summary, "確認できず");
  assert.deepEqual(JSON.parse(JSON.stringify(output.hiring_insights)), { media: "確認できず", roles: "確認できず", scale: "確認できず", sources: [] });
  assert.equal(output.pain_hypotheses[0].source_url, "");
  assert.equal(output.pain_hypotheses[0].confidence, "low");
});

test("an exact source title or unsupported name heading is not identity evidence", () => {
  for (const value of [
    grounded("製菓事業を営んでいます。"),
    grounded(`${name}\n製菓事業を営んでいます。`, [source], [{ text: "製菓事業を営んでいます。", sourceIndices: [0] }]),
    grounded(`${name}は製菓事業を営んでいます。`, [source], []),
    grounded(`${name}は製菓事業を営んでいます。`, [source], [{ text: `${name}は製菓事業を営んでいます。`, sourceIndices: [6] }]),
    grounded("別会社の公開情報です。", [source], [{ text: `${name}は製菓事業を営んでいます。`, sourceIndices: [0] }]),
  ]) assert.equal(scopeGroundingToCompany(name, value).companyMatch, "unconfirmed");
});

test("exact cited company sentences survive while unrelated sources and paragraphs are excluded", () => {
  const targetSentence = `${name}は菓子の製造を行っています。`;
  const unrelated = "別会社は新卒8名を募集しています。";
  const input = grounded(`${unrelated}\n${targetSentence}\n食品サンプルは人気です。`, [other, source], [
    { text: unrelated, sourceIndices: [0] },
    { text: targetSentence, sourceIndices: [1] },
  ]);
  const result = scopeGroundingToCompany(name, input);
  assert.equal(result.companyMatch, "supported");
  assert.equal(result.text, targetSentence);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, source.url);
  assert.equal(result.supports[0].sourceIndices[0], 0);
  assert.equal(result.searchHtml, suggestions);
  assert.equal(input.sources.length, 2, "does not mutate original metadata");
  const output = constrainVertexSources({ industry_summary: "菓子製造", sources: [source, other] }, result);
  assert.equal(output.industry_summary, "菓子製造");
  assert.equal(output.sources.length, 1);
});

test("mixed citation segments cannot attach another company's URLs to a target sentence", () => {
  const text = `${name}は菓子を製造しています。別会社は食品サンプルを製造しています。`;
  for (const sourceIndices of [[0, 1], [1]]) {
    const result = scopeGroundingToCompany(name, grounded(text, [source, other], [{ text, sourceIndices }]));
    assert.equal(result.companyMatch, "unconfirmed");
    assert.equal(result.sources.length, 0);
  }
});

test("normalization permits Markdown emphasis and width/spacing without matching similar names", () => {
  const sentence = "**検証 製菓 株式会社**は菓子製造を行っています。";
  assert.equal(scopeGroundingToCompany(name, grounded(sentence)).companyMatch, "supported");
  assert.equal(scopeGroundingToCompany(name, grounded("検証食品株式会社は食品を製造しています。")).companyMatch, "unconfirmed");
  assert.equal(scopeGroundingToCompany(name, grounded("新検証製菓株式会社は食品を製造しています。")).companyMatch, "unconfirmed");
  assert.equal(scopeGroundingToCompany(name, grounded("検証製菓株式会社別法人は食品を製造しています。")).companyMatch, "unconfirmed");
  assert.equal(scopeGroundingToCompany("", grounded(sentence)).companyMatch, "unconfirmed");
});

test("unconfirmed, assumed, or unavailable company claims fail closed even when cited", () => {
  for (const text of [
    `${name}は確認できず、似た社名の会社を調べました。`,
    `${name}という社名から食品サンプルを製造する可能性があります。`,
    `${name}の情報は未確認です。`,
    `${name}について公開情報を取得できませんでした。`,
    `${name}の公式情報はありません。`,
    `${name}は菓子メーカーで、別名の株式会社は食品サンプルを製造しています。`,
    `${name}は菓子メーカーで、食品見本有限会社は食品サンプルを製造しています。`,
    `${name} could not be identified.`,
  ]) assert.equal(scopeGroundingToCompany(name, grounded(text)).companyMatch, "unconfirmed");
});

test("formatting never receives unrelated raw research; exactly one search and one generation", async () => {
  const calls = [];
  const rawText = `${name}を特定できませんでした。別会社の秘密の混入文は食品サンプルです。`;
  const result = await vertexPreparation(name, { system: "schema", user: "内部商談メモ", maxTokens: 4000 }, async options => {
    calls.push(options);
    if (calls.length === 1) return { text: rawText, model: "offline", groundingMetadata: {
      groundingChunks: [{ web: { title: other.title, uri: other.url } }],
      groundingSupports: [{ segment: { text: rawText }, groundingChunkIndices: [0] }],
      searchEntryPoint: { renderedContent: suggestions },
    } };
    return { text: JSON.stringify({ industry_summary: "勝手な補完", sources: [other], hiring_insights: { media: "募集", sources: [other] }, proposal_story: "内部商談メモからの提案" }), model: "offline" };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].search, true);
  assert.equal(calls[1].search, undefined);
  assert.doesNotMatch(calls[1].user, /秘密の混入文|食品サンプル|other\.example/);
  assert.match(calls[1].user, /内部商談メモ/);
  assert.equal(result.parsed.industry_summary, "確認できず");
  assert.equal(result.parsed.proposal_story, "内部商談メモからの提案");
  assert.equal(result.grounding.companyMatch, "unconfirmed");
  assert.equal(result.grounding.searchHtml, suggestions);
});

test("explicit zero-output search becomes unknown public information and still uses internal notes", async () => {
  const calls = [];
  const result = await vertexPreparation(name, { system: "schema", user: "社内の商談原文: 予算80万円" }, async options => {
    calls.push(options);
    if (calls.length === 1) return { text: "", noSearchResult: true, model: "offline", usage: { promptTokenCount: 187, candidatesTokenCount: 0, totalTokenCount: 187 } };
    return { text: JSON.stringify({ industry_summary: "推測", sources: [], hiring_insights: { media: "推測", sources: [] }, proposal_story: "商談原文では予算80万円。" }), model: "offline" };
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /公開情報を確認できませんでした/);
  assert.match(calls[1].user, /社内の商談原文: 予算80万円/);
  assert.equal(result.parsed.industry_summary, "確認できず");
  assert.equal(result.parsed.hiring_insights.media, "確認できず");
  assert.equal(result.grounding.companyMatch, "unconfirmed");
  assert.equal(result.grounding.sources.length, 0);
  assert.equal(result.parsed.proposal_story, "商談原文では予算80万円。");
});

// PREP-B1: shape of a real Gemini grounding response for a large company. Chunk URIs are
// vertexaisearch redirect URLs and titles are bare domains (never identity evidence), segment
// texts omit the trailing 。, and the model writes the common short name (トヨタ自動車) or
// splits facts under label lines. These used to be discarded as a whole (companyMatch=unconfirmed).
const toyota = "トヨタ自動車株式会社";
const redirect = (id) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const vertexShaped = (text, segments) => groundingModule.extractVertexGrounding(text, {
  groundingChunks: [{ web: { title: "toyota.co.jp", uri: redirect("A1") } }, { web: { title: "global.toyota", uri: redirect("B2") } }, { web: { title: "daihatsu.co.jp", uri: redirect("C3") } }],
  groundingSupports: segments.map(([segmentText, groundingChunkIndices]) => ({ segment: { startIndex: 0, endIndex: 1, text: segmentText }, groundingChunkIndices })),
  searchEntryPoint: { renderedContent: suggestions },
  webSearchQueries: [`${toyota} 事業概要`, `${toyota} 新卒採用 公開情報`],
});

test("PREP-B1 a large company's cited facts survive common Japanese phrasing", () => {
  const text = [
    "### 事業概要",
    "**事業内容**：トヨタ自動車は、自動車の製造・販売を主な事業としています。",
    "同社は、電動化やソフトウェアの開発にも取り組んでいます。",
    "### 新卒採用",
    `${toyota}の新卒採用情報は、公式採用サイトで確認できます。`,
    "トヨタ自動車（株）は、技術職と事務職を募集しています。",
  ].join("\n");
  const result = scopeGroundingToCompany(toyota, vertexShaped(text, [
    ["**事業内容**：トヨタ自動車は、自動車の製造・販売を主な事業としています", [0]],
    ["同社は、電動化やソフトウェアの開発にも取り組んでいます", [1]],
    [`### 新卒採用\n${toyota}の新卒採用情報は、公式採用サイトで確認できます`, [1]],
    ["トヨタ自動車（株）は、技術職と事務職を募集しています", [0]],
  ]));
  assert.equal(result.companyMatch, "supported");
  assert.equal(result.sources.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sources.map(s => s.title))), ["toyota.co.jp", "global.toyota"]);
  assert.ok(result.sources.every(s => s.url.startsWith("https://vertexaisearch.cloud.google.com/")));
  assert.match(result.text, /自動車の製造・販売/);
  assert.match(result.text, /公式採用サイトで確認できます/);
  assert.match(result.text, /技術職と事務職/);
  assert.doesNotMatch(result.text, /新卒採用\n|###/, "heading lines are not kept as facts");
  assert.doesNotMatch(result.text, /電動化/, "a 同社 segment without a target sentence in it is not attributed");
  assert.equal(result.searchHtml, suggestions);
});

test("PREP-B1 a continuation sentence (同社) needs a preceding target sentence in the same cited segment", () => {
  const text = `${toyota}は、自動車メーカーです。同社は、電動化に取り組んでいます。`;
  const accepted = scopeGroundingToCompany(toyota, vertexShaped(text, [[text, [0]]]));
  assert.equal(accepted.companyMatch, "supported");
  assert.equal(accepted.supports.length, 2);
  const alone = scopeGroundingToCompany(toyota, vertexShaped("同社は、電動化に取り組んでいます。", [["同社は、電動化に取り組んでいます", [0]]]));
  assert.equal(alone.companyMatch, "unconfirmed");
});

test("PREP-B1 registered short name matches the formal name with a legal form", () => {
  const text = "トヨタ自動車株式会社は、自動車メーカーです。";
  assert.equal(scopeGroundingToCompany("トヨタ自動車", vertexShaped(text, [[text, [0]]])).companyMatch, "supported");
  const prefixed = "株式会社日立製作所は、社会イノベーション事業を推進しています。";
  assert.equal(scopeGroundingToCompany("日立製作所", grounded(prefixed)).companyMatch, "supported");
  // The name without its legal form counts once the text names the formal company affirmatively.
  const short = "日立製作所は、社会イノベーション事業を推進しています。";
  assert.equal(scopeGroundingToCompany("株式会社日立製作所", grounded(`${prefixed}\n${short}`, [source], [{ text: short, sourceIndices: [0] }])).companyMatch, "supported");
  assert.equal(scopeGroundingToCompany("株式会社日立製作所", grounded(short)).companyMatch, "unconfirmed");
});

test("PREP-B1 the relaxed matching still keeps other companies and unconfirmed claims out", () => {
  for (const [text, label] of [
    ["トヨタは、自動車メーカーです。", "unexplained abbreviation"],
    ["トヨタ自動車東日本は、小型車を製造しています。", "similar name"],
    ["トヨタ自動車九州株式会社は、レクサスを製造しています。", "similar name with legal form"],
    [`${toyota}は、ダイハツ工業株式会社を子会社に持ちます。`, "another company in the sentence"],
    [`${toyota}の子会社であるダイハツ工業(株)は、軽自動車を製造しています。`, "another company with (株)"],
    [`${toyota}の採用情報は確認できませんでした。`, "negative confirmation"],
    [`**ダイハツ工業株式会社**\n${toyota}は、自動車メーカーです。`, "label naming another company"],
    [`${toyota}は、自動車メーカーです。同社のグループ会社であるダイハツは軽自動車を製造しています。`, "continuation about another company"],
    [`${toyota}は、自動車メーカーです。新卒採用では技術職を募集しています。`, "sentence without a subject"],
    ["別会社は、自動車メーカーです。同社は、電動化に取り組んでいます。", "continuation after another company"],
  ]) {
    const result = scopeGroundingToCompany(toyota, vertexShaped(text, [[text, [0]]]));
    assert.equal(result.companyMatch, "unconfirmed", label);
    assert.equal(result.sources.length, 0, label);
  }
});

test("PREP-B1 an alias the search text defines for the target may be used as a subject", () => {
  const text = `${toyota}（以下、トヨタ）は、自動車メーカーです。\nトヨタは、技術職と事務職を募集しています。`;
  const result = scopeGroundingToCompany(toyota, vertexShaped(text, [
    [`${toyota}（以下、トヨタ）は、自動車メーカーです`, [0]],
    ["トヨタは、技術職と事務職を募集しています", [1]],
  ]));
  assert.equal(result.companyMatch, "supported");
  assert.equal(result.supports.length, 2);
});

// Independent review of the PREP-B1 fix: the name without its legal form is a weak spelling.
test("PREP-B1 review: the name without its legal form is not enough on its own (similar names, common words)", () => {
  for (const [registered, text, label] of [
    ["株式会社トヨタ", "トヨタは、世界最大級の自動車メーカーです。", "small company named like a large one"],
    ["株式会社トヨタ", "トヨタの売上高は45兆円です。", "small company named like a large one (の)"],
    ["株式会社日本", "日本の自動車市場は縮小しています。", "common word"],
    ["株式会社ミライ", "ミライの新卒採用は年20名です。", "common word (katakana)"],
    [toyota, "トヨタ自動車(米国)は、北米で自動車を販売しています。", "( after the short name is another entity"],
    [toyota, "トヨタ自動車は、自動車メーカーです。", "short name without any formal-name sentence in the text"],
  ]) {
    const result = scopeGroundingToCompany(registered, vertexShaped(text, [[text, [0]]]));
    assert.equal(result.companyMatch, "unconfirmed", label);
    assert.equal(result.sources.length, 0, label);
  }
  // A formal-name sentence elsewhere does not make a 2-character common word usable.
  const nihon = "株式会社日本は、人材サービスを提供しています。\n日本の自動車市場は縮小しています。";
  const scoped = scopeGroundingToCompany("株式会社日本", vertexShaped(nihon, [["日本の自動車市場は縮小しています", [0]]]));
  assert.equal(scoped.companyMatch, "unconfirmed");
  // (米国) stays another entity even when the formal name is in the text.
  const us = `${toyota}は、自動車メーカーです。\nトヨタ自動車(米国)は、北米で自動車を販売しています。`;
  assert.equal(scopeGroundingToCompany(toyota, vertexShaped(us, [["トヨタ自動車(米国)は、北米で自動車を販売しています", [0]]])).companyMatch, "unconfirmed");
});

test("PREP-B1 review: the short name is used once the text names the formal company affirmatively", () => {
  const text = `${toyota}は、自動車メーカーです。\nトヨタ自動車は、技術職を募集しています。`;
  const result = scopeGroundingToCompany(toyota, vertexShaped(text, [["トヨタ自動車は、技術職を募集しています", [0]]]));
  assert.equal(result.companyMatch, "supported");
  // A negative formal-name sentence does not unlock it.
  const negative = `${toyota}の情報は確認できませんでした。\nトヨタ自動車は、技術職を募集しています。`;
  assert.equal(scopeGroundingToCompany(toyota, vertexShaped(negative, [["トヨタ自動車は、技術職を募集しています", [0]]])).companyMatch, "unconfirmed");
});

test("PREP-B1 review: a plain label naming another company is not stripped as a heading", () => {
  for (const text of [
    "デンソー：トヨタ自動車株式会社は主要顧客で、売上の5割を占めます。",
    "デンソー:トヨタ自動車株式会社は主要顧客で、売上の5割を占めます。",
    "**デンソー株式会社**：トヨタ自動車株式会社は主要顧客です。",
  ]) assert.equal(scopeGroundingToCompany(toyota, vertexShaped(text, [[text, [0]]])).companyMatch, "unconfirmed", text);
});

test("PREP-B1 review: only the matched subject and standalone mentions of the name are removed before the other-company check", () => {
  const text = "株式会社ABCは、XYZABC株式会社と合併しました。";
  assert.equal(scopeGroundingToCompany("株式会社ABC", vertexShaped(text, [[text, [0]]])).companyMatch, "unconfirmed");
  const merged = `${toyota}は、トヨタ自動車株式会社九州と提携しています。`;
  assert.equal(scopeGroundingToCompany(toyota, vertexShaped(merged, [[merged, [0]]])).companyMatch, "unconfirmed");
  const repeated = `${toyota}は、${toyota}の新卒採用サイトで募集しています。`;
  assert.equal(scopeGroundingToCompany(toyota, vertexShaped(repeated, [[repeated, [0]]])).companyMatch, "supported");
});
