import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BANT_RECENT_MEETINGS_LIMIT,
  constrainBantStatus,
  findMeetingBantEvidence,
  isUnknownBantValue,
  normalizeUnconfirmedNeed,
  reconcileBantFromMeetings,
} from "../src/lib/ai/bant-reconciliation";
import { BANT_UNKNOWN_VALUES } from "../src/lib/ai/bant-definitions";

const unknownNeed = "新卒採用への応募数が不足しているか未集計のため不明。今回は情報交換が目的。";
const tentativeBudget = "制作費は80万円を目安に検討中。正式な社内承認は未取得。";
const hypotheticalNeed = "新卒採用の応募数に関する現状把握が必要な可能性あり（顧客は不足しているか未集計で不明と回答）";
const unknownNeedQuote = "応募数が不足しているかは、まだ集計していないので分かりません。今回は情報交換です。";

test("known contact role cannot turn an explicitly unknown final decision-maker into estimated authority", () => {
  for(const value of ["採用実務担当者。最終決裁者と正式な承認経路は未確認。","採用実務担当者であり、最終決裁者は未確認。正式な承認経路も未確認。","窓口は採用担当。誰が最終決裁者か未確認です。","採用実務担当者。今回の費用を最終決裁する人はまだ確認できていません。","採用実務担当者。最終決裁者、承認経路は未確認。まず上長に相談する予定だが、上長だけで決められるかは不明。","窓口は人事。最終決裁者・正式な承認経路は未確認です。"]){
    for(const status of ["confirmed","estimated","unknown"] as const) assert.equal(constrainBantStatus("authority",value,status),"unknown");
  }
  for(const value of ["決裁者は社長。承認経路は未確認。","決裁者は社長、承認経路は未確認。","決裁者は未確認だったが、現在は社長と確定。","決裁者は未確認。後の確認で決裁者は社長と判明。","最終決裁者、承認経路は未確認。後の確認で決裁者は社長と判明。"]){
    assert.equal(constrainBantStatus("authority",value,"confirmed"),"confirmed");
  }
});

test("long Need paraphrase recovers only the explicit customer problem statement and its literal quote", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const literal = "説明会後に一次面接へ進む学生が少なく、仕事内容の説明が伝わりにくいことが課題です。";
  const value = literal.replace("です。", "。") + "学生が働く場面を想像できないまま選考を受けるか迷っている状況を改善したい";
  const source = meeting({ transcript, bantNeed: value });
  const item = {value, quote:"", status:"estimated", source_meeting_id:source.id};
  const original = {need:value, items:{need:item}};
  const result = reconcileBantFromMeetings(original,[source]);
  const repaired = (result.items as Record<string, Record<string, unknown>>).need;
  assert.equal(result.need,literal);
  assert.equal(repaired.value,literal);
  assert.equal(repaired.quote,literal);
  assert.equal(repaired.status,"estimated");
  assert.equal(repaired.source_meeting_id,source.id);
  assert.equal(original.need,value);
  assert.equal(original.items.need.quote,"");
  assert.equal(reconcileBantFromMeetings(result,[source]),result);
  for(const transcript of [
    `営業：${literal}`,
    `顧客：もし${literal}`,
    `顧客：他社では${literal}`,
    `顧客：「${literal}」と営業に言われました。`,
    `顧客：${literal}\n顧客：${literal.replace("です。","かは未確認です。")}`,
  ]) {
    const result = reconcileBantFromMeetings(original,[{...source,transcript}]);
    assert.equal((result.items as Record<string, Record<string, unknown>>).need.quote, "");
  }
  const manual = {...original,manualFields:{need:true}};
  const manualResult = reconcileBantFromMeetings(manual,[source]);
  assert.equal(manualResult.need,manual.need);
  assert.equal((manualResult.items as Record<string, unknown>).need,item);
});

test("paraphrased long Need and missing budget citation recover qualified original evidence", () => {
  const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8");
  const need="説明会後に一次面接へ進む学生が少なく、仕事内容の説明が伝わりにくいという課題を解決したい。学生が働く場面を想像し、選考に進むか判断できる状態を目指している。";
  const budget="150万円（目安）。正式な社内承認は未了。";
  const source=meeting({transcript,bantNeed:need,bantBudget:budget});
  const current={need,budget,items:{need:{value:need,status:"estimated",source_meeting_id:source.id,quote:""},budget:{value:budget,status:"estimated",source_meeting_id:source.id,quote:""}}};
  const result=reconcileBantFromMeetings(current,[source]);
  const items=result.items as Record<string,{quote:string;status:string}>;
  assert.equal(items.need.quote,"説明会後に一次面接へ進む学生が少なく、仕事内容の説明が伝わりにくいことが課題です。");
  assert.equal(items.budget.quote,"現在の予算目安は150万円です。正式な社内承認はまだ取れていません。");
  assert.equal(items.budget.status,"estimated");
  for(const transcript of ["営業：予算目安は150万円です。正式な社内承認はまだ取れていません。","顧客：他社の予算目安は150万円です。","顧客：予算目安は150万円です。\n顧客：予算目安は180万円へ訂正しました。","顧客：予算150万円を承認しました。"]){
    const repaired=reconcileBantFromMeetings(current,[{...source,transcript}]);
    assert.equal((repaired.items as Record<string,{quote:string}>).budget.quote,"");
  }
});

test("generic information gathering or exchange stages alone normalize to unknown Need", () => {
  for (const value of ["情報収集", "情報交換", "情報収集段階", "情報交換段階", "情報収集の段階", "情報交換のみ", "情報収集段階です。", " 情報 交換 \n"]) {
    assert.equal(normalizeUnconfirmedNeed(value), BANT_UNKNOWN_VALUES.need, value);
    assert.equal(constrainBantStatus("need", value, "confirmed"), "unknown", value);
    const source = meeting({ bantNeed: value, transcript: `顧客：${value}` });
    assert.equal(findMeetingBantEvidence([source], "need"), null, "even literal stage evidence is not a concrete need");
    const item = Object.freeze({ value, status: "confirmed", source_meeting_id: source.id, quote: value.trim() });
    const existing = Object.freeze({ need: value, items: Object.freeze({ need: item }), custom: "keep" });
    const result = reconcileBantFromMeetings(existing, [source]);
    const updated = (result.items as Record<string, Record<string, unknown>>).need;
    assert.equal(result.need, BANT_UNKNOWN_VALUES.need);
    assert.equal(updated.value, BANT_UNKNOWN_VALUES.need);
    assert.equal(updated.status, "unknown");
    assert.equal(updated.quote, value.trim(), "preserve a literal statement without promoting its certainty");
    assert.equal(result.custom, "keep");
    assert.equal(existing.items.need, item);
    assert.equal(existing.need, value);
    assert.equal(reconcileBantFromMeetings(result, [source]), result, "normalization is idempotent");
  }
});

test("Need stage normalization leaves actual issues and all other wording unchanged", () => {
  for (const value of ["情報収集ツールを統一したい", "情報交換に時間がかかる", "情報収集段階の工数削減が課題", "情報収集。応募数不足が課題です。", "情報交換の段階ではあるが採用難に困っている", "未確認: 課題", "応募数は未集計のため不明", "  採用が課題です。  ", "", hypotheticalNeed]) {
    assert.equal(normalizeUnconfirmedNeed(value), value, value);
  }
  const concrete = "情報収集ツールを統一したい";
  const source = meeting({ bantNeed: concrete, bantBudget: null, bantAuthority: null, bantTimeline: null, transcript: `顧客：${concrete}` });
  assert.equal(findMeetingBantEvidence([source], "need")?.value, concrete);
  const item = { value: concrete, status: "confirmed", source_meeting_id: source.id, quote: concrete };
  const current = { need: concrete, items: { need: item } };
  assert.equal(reconcileBantFromMeetings(current, [source]), current);
});

test("generic automatic legacy values without items are repaired but manual stages stay untouched", () => {
  const source = meeting({ bantNeed: "情報収集", bantBudget: null, bantAuthority: null, bantTimeline: null, transcript: "顧客：情報収集です。" });
  const repaired = reconcileBantFromMeetings({ need: "情報収集" }, [source]);
  assert.equal(repaired.need, BANT_UNKNOWN_VALUES.need);
  assert.equal((repaired.items as Record<string, Record<string, unknown>>).need.status, "unknown");
  const manual = { need: "情報収集", manualFields: { need: true }, items: { need: { value: "情報収集", status: "confirmed", quote: "User edited this BANT field manually." } } };
  assert.equal(reconcileBantFromMeetings(manual, [source]), manual);
  const withProposal = { ...manual, aiSuggestion: { need: { value: "情報収集", status: "confirmed", source_meeting_id: source.id, quote: "情報収集です。" } } };
  const result = reconcileBantFromMeetings(withProposal, [source]);
  assert.equal(result.need, manual.need);
  assert.equal(result.items, manual.items);
  assert.equal("aiSuggestion" in result, false);
});

test("a generic stage does not suppress older concrete Need evidence within the existing limit", () => {
  const previous = meeting({ id: "previous", meetingDate: "2026-08-30", bantNeed: "情報収集ツールを統一したい", transcript: "顧客：情報収集ツールを統一したい" });
  const latest = meeting({ bantNeed: "情報交換段階", transcript: "顧客：情報交換段階です。" });
  const evidence = findMeetingBantEvidence([latest, previous], "need");
  assert.equal(evidence?.value, previous.bantNeed);
  assert.equal(evidence?.source_meeting_id, previous.id);
  assert.equal(evidence?.quote, previous.bantNeed);
});

test("generated hypothetical Need cannot fill an unknown from an unmeasured customer statement", () => {
  const source = meeting({ bantNeed: hypotheticalNeed, transcript: `顧客：${unknownNeedQuote}` });
  assert.equal(findMeetingBantEvidence([source], "need"), null);
  const existing = { need: "未確定: ニーズ課題を確認する必要あり", items: { need: { value: "未確定: ニーズ課題を確認する必要あり", status: "unknown", source_meeting_id: source.id, quote: unknownNeedQuote } } };
  const result = reconcileBantFromMeetings(existing, [source]);
  assert.equal(result.need, existing.need);
  assert.equal((result.items as Record<string, Record<string, unknown>>).need.status, "unknown");
  assert.equal((result.items as Record<string, Record<string, unknown>>).need.quote, unknownNeedQuote);
});

test("direct automatic hypotheses become unknown while manual values and literal unknown quotes remain", () => {
  const source = meeting({ bantNeed: hypotheticalNeed, transcript: `顧客：${unknownNeedQuote}` });
  for (const topLevel of [hypotheticalNeed, "未確認", undefined]) {
    const existing = { need: topLevel, items: { need: { value: hypotheticalNeed, status: "estimated", source_meeting_id: source.id, quote: unknownNeedQuote } } };
    const before = structuredClone(existing);
    const result = reconcileBantFromMeetings(existing, [source]);
    assert.equal(isUnknownBantValue(result.need), true);
    const item = (result.items as Record<string, Record<string, unknown>>).need;
    assert.equal(isUnknownBantValue(item.value), true);
    assert.equal(item.status, "unknown");
    assert.equal(item.quote, unknownNeedQuote);
    assert.equal(item.source_meeting_id, source.id);
    assert.deepEqual(existing, before);
    const manual = { ...existing, manualFields: { need: true } };
    assert.equal(reconcileBantFromMeetings(manual, []).items, manual.items);
    assert.equal(reconcileBantFromMeetings(manual, []).need, manual.need);
  }
});

test("a generated Need hypothesis does not hide earlier explicit evidence or discard tentative budget", () => {
  const old = meeting({ id: "older", meetingDate: "2026-08-30", bantNeed: "応募数不足が課題です。", transcript: "顧客：応募数不足が課題です。" });
  const recent = meeting({ bantNeed: hypotheticalNeed, bantBudget: tentativeBudget, transcript: `顧客：${unknownNeedQuote}\n顧客：${tentativeBudget}` });
  const need = findMeetingBantEvidence([recent, old], "need");
  assert.equal(need?.value, old.bantNeed);
  assert.equal(need?.source_meeting_id, old.id);
  assert.equal(need?.quote, old.bantNeed);
  const budget = findMeetingBantEvidence([recent, old], "budget");
  assert.equal(budget?.value, tentativeBudget);
  assert.equal(budget?.status, "estimated");
});

test("a customer's own tentative Need and the literal factual part of mixed text are retained", () => {
  const tentative = "選考途中の辞退が課題になっている可能性があります。";
  const source = meeting({ bantNeed: tentative, transcript: `顧客：${tentative}` });
  assert.equal(findMeetingBantEvidence([source], "need")?.value, tentative);
  const current = { need: tentative, items: { need: { value: tentative, status: "confirmed", source_meeting_id: source.id, quote: tentative } } };
  const projected = reconcileBantFromMeetings(current, [source]);
  assert.equal(projected.need, tentative);
  assert.equal((projected.items as Record<string, Record<string, unknown>>).need.status, "estimated");
  const fact = "応募数不足が課題です。";
  const mixed = `${fact}現状把握の支援が必要な可能性あり。`;
  const mixedSource = meeting({ bantNeed: mixed, transcript: `顧客：${fact}` });
  assert.equal(findMeetingBantEvidence([mixedSource], "need")?.value, fact);
  const mixedCurrent = { need: mixed, items: { need: { value: mixed, status: "estimated", source_meeting_id: mixedSource.id, quote: fact } } };
  const repaired = reconcileBantFromMeetings(mixedCurrent, [mixedSource]);
  assert.equal(repaired.need, fact);
  assert.equal((repaired.items as Record<string, Record<string, unknown>>).need.quote, fact);
  assert.equal(findMeetingBantEvidence([meeting({ bantNeed: `${unknownNeedQuote}\n現状把握が必要な可能性あり。`, transcript: `顧客：${unknownNeedQuote}` })], "need"), null);
});

test("unsupported Need proposals beside a manual field are removed without changing the manual record", () => {
  const source = meeting({ bantNeed: hypotheticalNeed, transcript: `顧客：${unknownNeedQuote}` });
  const existing = manualAggregate({ need: { value: hypotheticalNeed, status: "estimated", source_meeting_id: source.id, quote: unknownNeedQuote } });
  const result = reconcileBantFromMeetings(existing, [source]);
  assert.equal(result.need, existing.need);
  assert.equal(result.items, existing.items);
  assert.equal("aiSuggestion" in result, false);
});

test("live replacement Need recovers the complete positive customer sentence from its own meeting", () => {
  const quote = "新卒採用の応募数不足という課題は引き続きあります。";
  const transcript = `営業：現在の予算と導入希望時期、採用の課題を教えてください。\n顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。${quote}`;
  const source = meeting({ id: "latest", meetingDate: "2026-09-24", bantNeed: "新卒採用の応募数不足", transcript });
  const old = meeting({ id: "old", meetingDate: "2026-09-22", bantNeed: "新卒採用の応募数不足", transcript: "顧客：新卒採用の応募数不足が課題です。" });
  for (const value of ["新卒採用の応募数不足", "新卒採用の応募数不足。"])
    for (const missingQuote of ["", "新卒採用への応募数が不足しています。"])
      for (const status of ["confirmed", "estimated", "unknown"]) {
        const item = Object.freeze({ value, status, source_meeting_id: source.id, quote: missingQuote });
        const existing = Object.freeze({ need: value, items: Object.freeze({ need: item }) });
        const sources = [old, source];
        const before = structuredClone(sources);
        const result = reconcileBantFromMeetings(existing, sources);
        assert.equal(result.need, value);
        assert.deepEqual((result.items as Record<string, unknown>).need, { ...item, quote });
        assert.equal(existing.items.need.quote, missingQuote);
        assert.deepEqual(sources, before);
        assert.equal(reconcileBantFromMeetings(result, sources), result, "repair is idempotent");
      }
});

test("pasted customer Need wraps recover the exact LF or CRLF sentence without changing status or source", () => {
  const value = "新卒採用の応募数不足";
  for (const newline of ["\n", "\r\n"]) {
    for (const suffix of ["という課題は引き続きあります。", `という課題は引き続きありますが、${"対応方法を検討中です、".repeat(30)}引き続き課題です。`]) {
      const quote = `新卒採用の応募数不${newline}  足${suffix}`;
      const transcript = `営業：現在の予算と導入希望時期、採用の課題を教えてください。${newline}  顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。${quote}`;
      const source = meeting({ id: "wrapped-source", bantNeed: value, transcript });
      const beforeSource = structuredClone(source);
      for (const status of ["estimated", "unknown"]) {
        const item = Object.freeze({ value, status, source_meeting_id: source.id, quote: "" });
        const existing = Object.freeze({ need: value, items: Object.freeze({ need: item }) });
        const result = reconcileBantFromMeetings(existing, [source]);
        assert.equal(result.need, value);
        assert.deepEqual((result.items as Record<string, unknown>).need, { ...item, quote });
        assert.ok(transcript.includes(quote), "quote is an unchanged original substring");
        assert.equal(existing.items.need.quote, "");
        assert.deepEqual(source, beforeSource);
        assert.equal(reconcileBantFromMeetings(result, [source]), result);
      }
      const manual = manualAggregate({ need: { value, status: "estimated", source_meeting_id: source.id, quote: "" } });
      const repaired = reconcileBantFromMeetings(manual, [source]);
      assert.equal(repaired.need, manual.need);
      assert.equal(repaired.items, manual.items);
      assert.equal((repaired.aiSuggestion as Record<string, Record<string, unknown>>).need.quote, quote);
    }
  }
});

test("Need wrap recovery respects physical and speaker boundaries and all sentence qualifiers", () => {
  const value = "新卒採用の応募数不足";
  for (const transcript of [
    "顧客：新卒採用の応募数不\n\n  足という課題は引き続きあります。",
    "顧客：新卒採用の応募数不\n  \n  足という課題は引き続きあります。",
    "顧客：新卒採用の応募数不\n足という課題は引き続きあります。",
    "顧客：新卒採用の応募数不\n  営業：足という課題は引き続きあります。",
    "顧客：新卒採用の応募数不\n  田中：足という課題は引き続きあります。",
    "顧客：新卒採用の応募数不。\n  足という課題は引き続きあります。",
    "新卒採用の応募数不\n  足という課題は引き続きあります。",
    "顧客：新卒採用の応募数不\n  足という課題はありま\n  せん。",
    "顧客：他\n  社では新卒採用の応募数不\n  足が課題です。",
    "顧客：営業から「新卒採用の応募数不\n  足が課題です」と説明されました。",
    "顧客：新卒採用の応募数不\n  足が課題ですか\n  ね。",
    "顧客：新卒採用の応募数不\n  足が課題である可能\n  性があります。",
    "顧客：新卒採用の応募数不\n  足という課題は未確\n  認です。",
  ]) {
    const source = meeting({ id: "wrap-boundary", bantNeed: value, transcript });
    const item = { value, status: "estimated", source_meeting_id: source.id, quote: "" };
    const result = reconcileBantFromMeetings({ need: value, items: { need: item } }, [source]);
    assert.equal((result.items as Record<string, Record<string, unknown>>).need.quote, "", transcript);
  }
});

test("Need quote recovery does not borrow other meetings, paraphrases, or uncertain and negative statements", () => {
  const value = "新卒採用の応募数不足";
  const positive = "新卒採用の応募数不足という課題は引き続きあります。";
  const valid = meeting({ id: "valid", meetingDate: "2026-09-23", bantNeed: value, transcript: `顧客：${positive}` });
  const cases = [
    { sourceId: "another-deal", source: valid },
    { sourceId: "", source: valid },
    ...[
      "営業：新卒採用の応募数不足が課題ですか？",
      "顧客：新卒採用の応募数不足が課題ですか",
      "顧客：新卒採用の応募数不足が課題ですかね。",
      "顧客：他社では新卒採用の応募数不足が課題です。",
      "顧客：営業から「新卒採用の応募数不足が課題です」と説明されました。",
      "顧客：新卒採用の応募数不足が課題ですと聞いています。",
      "顧客：新卒採用の応募数不足という課題は未確認です。",
      "顧客：新卒採用の応募数不足という課題はありません。",
      "顧客：新卒採用の応募数不足という課題はもうありません。",
      "顧客：新卒採用の応募数不足が課題である可能性があります。",
      "顧客：もし新卒採用の応募数不足が課題なら相談します。",
      "顧客：新卒採用の応募数不足が課題です。営業：改善しましょう。",
      "顧客：採用への応募者が少ないことが課題です。",
      positive,
      `顧客：${positive}\n顧客：新卒採用の応募数不足という課題は撤回します。`,
    ].map((transcript) => ({ sourceId: "wrong", source: meeting({ id: "wrong", bantNeed: value, transcript }) })),
    { sourceId: "wrong", source: meeting({ id: "wrong", bantNeed: value, transcript: "顧客：課題は未確認です。", minutes: `顧客：${positive}`, minutesJson: { summary: positive }, sourceType: "manual_text" }) },
  ];
  for (const { sourceId, source } of cases) {
    for (const quote of ["", "原文にない引用"]) {
      const item = { value, status: "estimated", source_meeting_id: sourceId, quote };
      const result = reconcileBantFromMeetings({ need: value, items: { need: item } }, [source, ...(source === valid ? [] : [valid])]);
      const repaired = (result.items as Record<string, Record<string, unknown>>).need;
      assert.equal(repaired.quote, "", source.transcript);
      assert.equal(repaired.value, value);
      assert.equal(repaired.source_meeting_id, sourceId === source.id ? sourceId : "");
    }
  }
});

test("Need citation repair preserves manual values and only updates an existing automatic proposal", () => {
  const value = "新卒採用の応募数不足";
  const quote = "新卒採用の応募数不足という課題は引き続きあります。";
  const source = meeting({ bantNeed: value, transcript: `顧客：${quote}` });
  const existing = manualAggregate({ need: { value, status: "estimated", source_meeting_id: source.id, quote: "" } });
  const before = structuredClone(existing);
  const result = reconcileBantFromMeetings(existing, [source]);
  assert.equal(result.need, existing.need);
  assert.equal(result.items, existing.items);
  assert.deepEqual((result.aiSuggestion as Record<string, unknown>).need, { ...(existing.aiSuggestion.need as Record<string, unknown>), quote });
  assert.deepEqual(existing, before);
});

test("unknown-only explanations are not positive meeting evidence", () => {
  for (const value of [
    unknownNeed,
    "応募数が不足しているかは、まだ集計していないので分かりません。今回は情報交換です。",
    "予算や決裁者、導入時期はいずれも未確認です。導入するかどうかも決めていません。",
    "応募数が不足しているかは未調査のため不明です。",
  ]) {
    assert.equal(isUnknownBantValue(value), true, value);
    assert.equal(constrainBantStatus("need", value, "confirmed"), "unknown");
    assert.equal(findMeetingBantEvidence([meeting({ bantNeed: value })], "need"), null);
  }
});

test("unknown words in concrete or mixed information do not erase the actual information", () => {
  for (const value of [
    tentativeBudget,
    "未確認: 制作費80万円を目安に検討中、正式な社内承認は未取得。",
    "9月導入を予定。具体的な日は未定。",
    "応募数不足が課題です。辞退理由は未確認です。",
    "採用予定は8名、応募数は不明。",
    "未定だったが、9月15日で合意した。",
    "採用人数は年間8名を予定。\n応募数は不明。",
    "応募数不足は確認済みだが、原因は不明",
    "採用難が課題で、辞退理由は未確認",
  ]) assert.equal(isUnknownBantValue(value), false, value);
});

test("tentative budget certainty is bounded by the value or its direct quote", () => {
  const quote = "制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。";
  assert.equal(constrainBantStatus("budget", tentativeBudget, "confirmed", quote), "estimated");
  assert.equal(constrainBantStatus("budget", "80万円", "confirmed", quote), "estimated");
  assert.equal(constrainBantStatus("budget", "予算80万円は承認待ち", "confirmed"), "estimated");
  assert.equal(constrainBantStatus("budget", tentativeBudget, "unknown"), "unknown", "never promote a model unknown");
  assert.equal(constrainBantStatus("budget", "制作費80万円は正式に社内承認済みです。", "confirmed"), "confirmed");
  assert.equal(constrainBantStatus("budget", "80万円を確保しました。", "confirmed"), "confirmed");
  assert.equal(constrainBantStatus("budget", "制作費80万円は正式承認済み。導入時期は検討中", "confirmed"), "confirmed");
  assert.equal(constrainBantStatus("budget", "制作費80万円は正式承認済み、導入時期は検討中", "confirmed"), "confirmed");
  assert.equal(constrainBantStatus("budget", "制作費80万円。導入時期は検討中", "confirmed"), "confirmed");
  assert.equal(constrainBantStatus("need", "経費承認待ちの手間が課題", "confirmed"), "confirmed");
});

test("conditional wishes and explicitly unconfirmed timing cannot be confirmed by a model", () => {
  const quote = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
  for (const value of [
    quote,
    "導入するなら、2027年6月を希望します。正式な時期は未確定です。",
    "2027年6月に導入を希望します。",
    "導入時期は2027年6月。正式な時期は未確定です。",
    "導入は2027年6月です。\n顧客：正式な時期は未確定です。",
    "2027年6月希望",
    "導入する場合は2027年6月です。",
    "導入するなら2027-06-01を希望します。",
  ]) {
    assert.equal(constrainBantStatus("timeline", value, "confirmed"), "estimated", value);
    assert.equal(constrainBantStatus("timeline", value, "unknown"), "unknown", "never promote an unknown status");
    assert.equal(constrainBantStatus("timeline", value, "estimated"), "estimated");
  }
  assert.equal(constrainBantStatus("timeline", "2027年6月", "confirmed", quote), "estimated", "a concise value still retains quote uncertainty");
  assert.equal(constrainBantStatus("timeline", "2027/06/01", "confirmed", "導入するなら2027年6月1日を希望します。"), "estimated");
  assert.equal(constrainBantStatus("timeline", BANT_UNKNOWN_VALUES.timeline, "confirmed", quote), "unknown");
});

test("Timeline certainty does not join unrelated subjects, dates, or negated wishes", () => {
  for (const value of [
    "導入は2027年6月を希望ではなく決定済みです。",
    "導入は2027年6月の希望ではありません。決定済みです。",
    "予算は目安、導入6月は決定済み。",
    "次回面談の希望6月、導入7月決定済み。",
    "導入は2027年6月決定済み。正式な予算は未確定です。",
    "導入は2027年6月決定済み。正式な時期は未確定ではありません。",
    "2027年6月の導入を希望していましたが、7月で決定済みです。",
    "未定だったが、9月15日で合意した。",
  ]) assert.equal(constrainBantStatus("timeline", value, "confirmed"), "confirmed", value);
  assert.equal(constrainBantStatus("timeline", "2027年7月に導入決定済み", "confirmed",
    "次回面談は2027年6月を希望。導入は2027年7月で決定済み。"), "confirmed");
  assert.equal(constrainBantStatus("timeline", "2027年7月に導入決定済み", "confirmed",
    "導入するなら2027年6月を希望していました。導入は2027年7月で決定済み。"), "confirmed");
  assert.equal(constrainBantStatus("timeline", "2027年7月に導入決定済み", "confirmed",
    "別拠点の導入は2027年6月を希望。本拠点は2027年7月で決定済み。"), "confirmed", "a wish for a different date must not qualify the value");
  assert.equal(constrainBantStatus("budget", "120万円は承認済み", "confirmed",
    "導入するなら2027年6月を希望します。正式な時期は未確定です。"), "confirmed");
});

test("read projection downgrades saved conditional Timeline without rewriting or mutating evidence", () => {
  const quote = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
  const source = meeting({ id: "new-plan", meetingDate: "2026-09-24", bantTimeline: quote, transcript: `顧客：${quote}` });
  for (const value of [quote, "2027年6月"]) {
    const timeline = Object.freeze({ value, status: "confirmed", source_meeting_id: source.id, quote });
    const existing = Object.freeze({ timeline: value, items: Object.freeze({ timeline }), custom: "keep" });
    const result = reconcileBantFromMeetings(existing, [source]);
    assert.equal(result.timeline, value);
    assert.deepEqual((result.items as Record<string, unknown>).timeline, { ...timeline, status: "estimated" });
    assert.equal(result.custom, "keep");
    assert.equal(existing.items.timeline.status, "confirmed", "read projection does not mutate saved data");
    assert.equal(reconcileBantFromMeetings(result, [source]), result, "projection is idempotent");
  }
});

test("latest replacement Timeline recovers a missing or nonliteral quote from the same grounded meeting", () => {
  const raw = "顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。新卒採用の応募数不足という課題は引き続きあります。";
  const value = "導入するなら2027年6月を希望。正式な導入時期は未確定";
  const latest = meeting({ id: "replacement", meetingDate: "2026-09-24", bantTimeline: `文字起こし記載: ${raw}`, transcript: `営業：現在の予算と導入希望時期、採用の課題を教えてください。\n${raw}` });
  const old = meeting({ id: "old", meetingDate: "2026-09-22", bantTimeline: "2027年4月希望", transcript: "顧客：導入は2027年4月を希望します。" });
  const withdrawal = meeting({ id: "withdrawal", meetingDate: "2026-09-23", bantTimeline: BANT_UNKNOWN_VALUES.timeline, transcript: "顧客：前回の2027年4月の導入希望は撤回します。現在、導入時期は未定です。" });
  for (const quote of ["", "導入するなら2027年6月を希望。正式な導入時期は未確定"]) {
    const timeline = Object.freeze({ value, status: "estimated", source_meeting_id: latest.id, quote });
    const existing = Object.freeze({ timeline: value, items: Object.freeze({ timeline }) });
    const sources = [old, withdrawal, latest];
    const beforeSources = structuredClone(sources);
    const result = reconcileBantFromMeetings(existing, sources);
    assert.equal(result.timeline, value, "the aggregate wording is retained");
    assert.deepEqual((result.items as Record<string, unknown>).timeline, { ...timeline, quote: raw });
    assert.equal(existing.items.timeline.quote, quote, "saved input is not mutated");
    assert.deepEqual(sources, beforeSources, "old and latest meeting records are unchanged");
    assert.equal(reconcileBantFromMeetings(result, sources), result, "quotation repair is idempotent");
  }
});

test("recovered Timeline quotes preserve full conditions, CRLF context, and a manual field", () => {
  const value = "導入するなら2027年6月希望";
  for (const raw of [
    `顧客：導入するなら2027年6月を希望します。${"追加説明です。".repeat(40)}正式な導入時期は未確定です。`,
    "顧客：導入するなら2027年6月を希望します。\r\n顧客：正式な導入時期は未確定です。",
  ]) {
    const source = meeting({ bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: `文字起こし記載: ${raw.replace(/\r\n/gu, "\n")}`, transcript: raw });
    assert.equal(findMeetingBantEvidence([source], "timeline")?.quote, raw, "deterministic meeting fallback also retains the complete caveat");
    const proposal = Object.freeze({ value, status: "confirmed", source_meeting_id: source.id, quote: "" });
    const existing = manualAggregate({ timeline: proposal });
    const result = reconcileBantFromMeetings(existing, [source]);
    assert.equal(result.timeline, existing.timeline);
    assert.equal(result.items, existing.items);
    assert.deepEqual((result.aiSuggestion as Record<string, unknown>).timeline, { ...proposal, status: "estimated", quote: raw });
    assert.equal((existing.aiSuggestion.timeline as typeof proposal).quote, "");
  }
});

test("T04: Timeline quote recovery reads a one-line transcript per speaker turn, like the meeting analysis", () => {
  const turn = "話者2: 導入するなら2027年6月に動画を公開したいです。";
  const transcript = `話者1: 導入時期のご希望はありますか。 ${turn} 話者1: 承知しました。`;
  const source = meeting({ bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: `文字起こし記載: ${turn}`, transcript });
  const proposal = Object.freeze({ value: "導入するなら2027年6月希望", status: "confirmed", source_meeting_id: source.id, quote: "" });
  const result = reconcileBantFromMeetings(manualAggregate({ timeline: proposal }), [source]);
  const suggestion = (result.aiSuggestion as Record<string, Record<string, unknown>>).timeline;
  assert.equal(suggestion.quote, turn);
  assert.ok(transcript.includes(String(suggestion.quote)));
  // A different date is never quoted with this turn: the value is replaced by the meeting's grounded Timeline (same as multi-line).
  const other = reconcileBantFromMeetings(manualAggregate({ timeline: { ...proposal, value: "導入するなら2027年7月希望" } }), [source]);
  assert.deepEqual((other.aiSuggestion as Record<string, Record<string, unknown>>).timeline,
    { value: `文字起こし記載: ${turn}`, status: "estimated", source_meeting_id: source.id, quote: turn });
});

test("Timeline quote recovery cannot borrow a different meeting, date, question, or generated source", () => {
  const raw = "顧客：導入するなら2027年6月を希望します。正式な導入時期は未確定です。";
  const value = "導入するなら2027年6月希望";
  const valid = meeting({ id: "valid", meetingDate: "2026-09-23", bantTimeline: `文字起こし記載: ${raw}`, transcript: raw });
  const cases = [
    { sourceId: "another-deal", source: valid },
    { sourceId: "", source: valid },
    { sourceId: "wrong", source: meeting({ id: "wrong", bantTimeline: "文字起こし記載: 顧客：導入は2027年7月希望です。", transcript: "顧客：導入は2027年7月希望です。" }) },
    { sourceId: "wrong", source: meeting({ id: "wrong", bantTimeline: `文字起こし記載: ${raw}`, transcript: "顧客：導入時期は未確認です。", minutes: raw, minutesJson: { summary: raw }, sourceType: "manual_text" }) },
    { sourceId: "wrong", source: meeting({ id: "wrong", bantTimeline: "文字起こし記載: 営業：導入は2027年6月をご希望ですか？", transcript: "営業：導入は2027年6月をご希望ですか？" }) },
    { sourceId: "wrong", source: meeting({ id: "wrong", bantTimeline: "文字起こし記載: 顧客：次回面談は2027年6月を希望します。", transcript: "顧客：次回面談は2027年6月を希望します。" }) },
    { sourceId: "wrong", source: meeting({ id: "wrong", bantTimeline: `文字起こし記載: ${raw}`, transcript: "顧客：新卒採用の応募数不足という課題は引き続きあります。" }) },
  ];
  for (const { sourceId, source } of cases) {
    const timeline = { value, status: "estimated", source_meeting_id: sourceId, quote: "架空の引用" };
    const result = reconcileBantFromMeetings({ timeline: value, items: { timeline } }, [source, ...(source === valid ? [] : [valid])]);
    const repaired = (result.items as Record<string, Record<string, unknown>>).timeline;
    assert.equal(repaired.value, value);
    assert.equal(repaired.quote, "", source.transcript);
    assert.equal(repaired.source_meeting_id, sourceId === source.id ? sourceId : "", "do not reassign an unverifiable source");
  }
});

test("conditional Timeline repairs only the AI proposal beside a preserved manual value", () => {
  const quote = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
  const source = meeting({ bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: quote, transcript: `顧客：${quote}` });
  const timeline = Object.freeze({ value: quote, status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." });
  const existing = Object.freeze({
    timeline: quote,
    manualFields: Object.freeze({ timeline: true }),
    items: Object.freeze({ timeline }),
    aiSuggestion: Object.freeze({ timeline: Object.freeze({ value: quote, status: "confirmed", source_meeting_id: source.id, quote }) }),
  });
  const result = reconcileBantFromMeetings(existing, [source]);
  assert.equal(result.timeline, existing.timeline);
  assert.equal(result.items, existing.items);
  assert.equal(result.manualFields, existing.manualFields);
  assert.deepEqual((result.aiSuggestion as Record<string, unknown>).timeline, { ...existing.aiSuggestion.timeline, status: "estimated" });
  assert.equal(existing.aiSuggestion.timeline.status, "confirmed");
});

test("read projection repairs automatic certainty without rewriting evidence or reviving older needs", () => {
  const needItem = Object.freeze({ value: unknownNeed, status: "confirmed", source_meeting_id: "latest", quote: "応募数が不足しているかは未集計なので不明です。" });
  const budgetItem = Object.freeze({ value: tentativeBudget, status: "confirmed", source_meeting_id: "latest", quote: "制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。" });
  const existing = Object.freeze({ need: unknownNeed, budget: tentativeBudget, items: Object.freeze({ need: needItem, budget: budgetItem }), custom: "keep", confidence: 0 });
  const sources = [meeting(), meeting({ id: "latest", meetingDate: "2026-09-23", bantNeed: unknownNeed, bantBudget: tentativeBudget, transcript: `${needItem.quote}\n${budgetItem.quote}` })];
  const result = reconcileBantFromMeetings(existing, sources);
  const items = result.items as Record<string, Record<string, unknown>>;
  assert.equal(result.need, unknownNeed);
  assert.equal(result.budget, tentativeBudget);
  assert.deepEqual(items.need, { ...needItem, status: "unknown" });
  assert.deepEqual(items.budget, { ...budgetItem, status: "estimated" });
  assert.equal(result.custom, "keep");
  assert.equal(result.confidence, 0);
  assert.equal(existing.items.need.status, "confirmed");
  assert.equal(existing.items.budget.status, "confirmed");
  assert.equal(reconcileBantFromMeetings(result, sources), result, "projection is idempotent");
});

test("manual values and items bypass automatic certainty repairs", () => {
  const existing = { need: unknownNeed, budget: tentativeBudget, manualFields: { need: true, budget: true }, items: {
    need: { value: unknownNeed, status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." },
    budget: { value: tentativeBudget, status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." },
  } };
  assert.equal(reconcileBantFromMeetings(existing, []), existing);
});

test("a cited automatic proposal can have its certainty repaired beside unchanged manual items", () => {
  const source = meeting({ bantNeed: unknownNeed, bantBudget: tentativeBudget, transcript: `${unknownNeed}\n${tentativeBudget}` });
  const existing = manualAggregate({
    need: { value: unknownNeed, status: "confirmed", source_meeting_id: source.id, quote: unknownNeed },
    budget: { value: tentativeBudget, status: "confirmed", source_meeting_id: source.id, quote: tentativeBudget },
  });
  const before = structuredClone(existing);
  const result = reconcileBantFromMeetings(existing, [source]);
  const suggestions = result.aiSuggestion as Record<string, Record<string, unknown>>;
  assert.equal(suggestions.need.status, "unknown");
  assert.equal(suggestions.budget.status, "estimated");
  assert.equal(result.items, existing.items);
  assert.equal(result.need, existing.need);
  assert.equal(result.budget, existing.budget);
  assert.deepEqual(existing, before);
});

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: "meeting-1",
    meetingDate: new Date("2026-08-31T01:00:00Z"),
    bantBudget: "文字起こし記載: 顧客: 300万円を確保しています。",
    bantAuthority: "最終決裁は代表取締役",
    bantNeed: "技術職の採用が課題",
    bantTimeline: "9月15日の経営会議で決裁",
    transcript: "顧客: 300万円を確保しています。\n最終決裁は代表取締役です。\n技術職の採用が課題です。\n9月15日の経営会議で決裁します。",
    minutes: null,
    ...overrides,
  };
}

test("fills the stale deal aggregate with saved meeting BANT and literal sources", () => {
  const existing = {
    budget: "未確定: 予算を確認する必要あり",
    authority: "未確認: 決裁者情報なし",
    need: "",
    timeline: null,
    industry: "製造業",
    meetingNotes: "existing Notion notes",
  };
  const source = meeting();
  const result = reconcileBantFromMeetings(existing, [source]);
  assert.match(String(result.budget), /300万円/u);
  assert.equal(result.authority, "最終決裁は代表取締役");
  assert.equal(result.need, "技術職の採用が課題");
  assert.equal(result.timeline, "9月15日の経営会議で決裁");
  assert.equal(result.industry, existing.industry);
  assert.equal(result.meetingNotes, existing.meetingNotes);
  const items = result.items as Record<string, { status: string; source_meeting_id: string; quote: string }>;
  for (const item of Object.values(items)) {
    assert.equal(item.status, "estimated");
    assert.equal(item.source_meeting_id, "meeting-1");
    assert.ok(source.transcript.includes(item.quote));
  }
  assert.equal(items.budget.quote, "顧客: 300万円を確保しています。");
  assert.equal(existing.budget, "未確定: 予算を確認する必要あり");
  assert.equal("items" in existing, false);
});

test("preserves concrete values, explicit manual unknowns, nested items and unrelated keys", () => {
  const authorityItem = { value: "既存の役員会", status: "confirmed", source_meeting_id: "original", quote: "最終決裁は既存の役員会です。" };
  const existing = {
    budget: "手修正済みの200万円",
    authority: { value: "既存の役員会" },
    need: "未確認: 手動で保留中",
    timeline: "未確定",
    manualFields: { need: true },
    items: { authority: authorityItem, custom: "keep" },
    aiSuggestion: { budget: { value: "別の提案" } },
    custom: { preserve: true },
    updatedBy: "manual",
  };
  const before = structuredClone(existing);
  const result = reconcileBantFromMeetings(existing, [meeting(), meeting({ id: "original", meetingDate: "2026-08-30", transcript: authorityItem.quote })]);
  assert.equal(result.budget, existing.budget);
  assert.deepEqual(result.authority, existing.authority);
  assert.equal(result.need, existing.need);
  assert.equal(result.timeline, "9月15日の経営会議で決裁");
  assert.equal((result.items as Record<string, unknown>).authority, authorityItem);
  assert.equal((result.items as Record<string, unknown>).custom, "keep");
  assert.equal(result.aiSuggestion, existing.aiSuggestion);
  assert.equal(result.custom, existing.custom);
  assert.equal(result.updatedBy, "manual");
  assert.deepEqual(existing, before);
});

test("uses date order and skips newer unknowns without mutating the meeting array", () => {
  const old = meeting({ id: "old", meetingDate: "2026-08-29T01:00:00Z", bantBudget: "240万円" });
  const latest = meeting({ id: "latest", meetingDate: "2026-08-31T01:00:00Z", bantBudget: "未確認: 金額なし" });
  const recent = meeting({ id: "recent", meetingDate: "2026-08-30T01:00:00Z", bantBudget: "300万円" });
  const meetings = Object.freeze([old, latest, recent]);
  assert.equal(findMeetingBantEvidence(meetings, "budget")?.source_meeting_id, "recent");
  assert.deepEqual(meetings.map((item) => item.id), ["old", "latest", "recent"]);
});

test("never reaches beyond the latest five meetings to fill an unknown", () => {
  const meetings = Array.from({ length: 6 }, (_, index) => meeting({
    id: `meeting-${index}`,
    meetingDate: `2026-08-${String(31 - index).padStart(2, "0")}T01:00:00Z`,
    bantBudget: index === 5 ? "古い300万円" : "未確定: 予算なし",
  }));
  assert.equal(BANT_RECENT_MEETINGS_LIMIT, 5);
  assert.equal(findMeetingBantEvidence(meetings.reverse(), "budget"), null);
});

test("does not label a generated paraphrase as a verbatim quote", () => {
  const evidence = findMeetingBantEvidence([meeting({
    bantBudget: "予算300万円は承認済み",
    transcript: "顧客: 予算はまだ相談中です。",
    minutes: "予算額を相談した。",
  })], "budget");
  assert.equal(evidence?.value, "予算300万円は承認済み");
  assert.equal(evidence?.status, "estimated");
  assert.equal(evidence?.quote, "");
});

test("can quote an explicitly manual stored minutes passage when no transcript matches", () => {
  const evidence = findMeetingBantEvidence([meeting({
    bantBudget: "240万円",
    transcript: null,
    minutes: "提案金額は240万円、最終見積は次回。",
    sourceType: "manual_text", minutesJson: null,
  })], "budget");
  assert.equal(evidence?.quote, "240万円");
});

test("derived BANT and AI minutes cannot validate automatic quotes even if they repeat each other", () => {
  const invented = "決裁者は山田部長です。";
  const value = "山田部長";
  for (const provenance of [
    { sourceType: "manual_text", minutesJson: { summary: invented } },
    { sourceType: "upload", minutesJson: null },
    { sourceType: "meet_auto", minutesJson: { summary: invented } },
    {},
  ]) {
    const source = meeting({ transcript: "顧客：決裁者は未確認です。", minutes: invented, bantAuthority: value, ...provenance });
    const item = Object.freeze({ value, status: "confirmed", source_meeting_id: source.id, quote: invented });
    const existing = Object.freeze({ authority: value, items: Object.freeze({ authority: item }) });
    const result = reconcileBantFromMeetings(existing, [source]);
    const repaired = (result.items as Record<string, typeof item>).authority;
    assert.equal(repaired.value, value);
    assert.equal(repaired.quote, "");
    assert.equal(repaired.status, "estimated");
    assert.equal(repaired.source_meeting_id, source.id);
    assert.equal(existing.items.authority.quote, invented);
    assert.equal(findMeetingBantEvidence([source], "authority")?.quote, "");
    assert.equal(reconcileBantFromMeetings(result, [source]), result);
  }
});

test("primary transcript quotes survive generated minutes and explicitly manual written quotes remain valid", () => {
  for (const source of [
    meeting({ transcript: "顧客：決裁者は山田部長です。", minutes: "決裁者は佐藤部長です。", minutesJson: { summary: "決裁者は佐藤部長です。" } }),
    meeting({ transcript: null, minutes: "顧客記入：決裁者は山田部長です。", minutesJson: null, sourceType: "manual_text" }),
  ]) {
    const item = { value: "山田部長", status: "confirmed", source_meeting_id: source.id, quote: "決裁者は山田部長です。" };
    const existing = { authority: item.value, items: { authority: item } };
    const result = reconcileBantFromMeetings(existing, [source]);
    assert.equal((result.items as Record<string, unknown>).authority, item);
  }
});

test("unknown derived quotations are cleared without inventing alternatives or changing unknown status", () => {
  const authority = "未確認: 社内承認プロセスや決裁者が不明。";
  const timeline = "未確認: 導入時期は未決定。";
  const source = meeting({ transcript: "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。", minutes: "予算80万円を検討中。", minutesJson: { summary: "予算80万円を検討中。" }, bantAuthority: authority, bantTimeline: timeline });
  const existing = { authority, timeline, items: {
    authority: { value: authority, status: "unknown", source_meeting_id: source.id, quote: authority },
    timeline: { value: timeline, status: "unknown", source_meeting_id: source.id, quote: timeline },
  } };
  const result = reconcileBantFromMeetings(existing, [source]);
  for (const key of ["authority", "timeline"] as const) {
    const item = (result.items as Record<string, Record<string, unknown>>)[key];
    assert.equal(result[key], existing[key]);
    assert.equal(item.quote, "");
    assert.equal(item.status, "unknown");
    assert.equal(item.source_meeting_id, source.id);
  }
});

test("foreign and older-than-five quote sources do not survive as verified citations", () => {
  const sources = Array.from({ length: 6 }, (_, index) => meeting({ id: `source-${index}`, meetingDate: `2026-08-${31 - index}`, transcript: "予算300万円を確保しました。" }));
  for (const sourceId of ["another-deal", "source-5"]) {
    const item = { value: "300万円", status: "confirmed", source_meeting_id: sourceId, quote: "予算300万円を確保しました。" };
    const result = reconcileBantFromMeetings({ budget: item.value, items: { budget: item } }, sources);
    const repaired = (result.items as Record<string, Record<string, unknown>>).budget;
    assert.equal(result.budget, "300万円");
    assert.equal(repaired.quote, "");
    assert.equal(repaired.source_meeting_id, "");
    assert.equal(repaired.status, "estimated");
  }
});

test("manual data stays untouched when its automatic proposal has only a generated quotation", () => {
  const source = meeting({ transcript: "予算については社内で相談中です。", minutes: "予算は80万円です。", minutesJson: { summary: "予算は80万円です。" }, sourceType: "manual_text", bantBudget: "80万円" });
  const existing = manualAggregate({ budget: { value: "80万円", status: "confirmed", source_meeting_id: source.id, quote: "予算は80万円です。" } });
  const result = reconcileBantFromMeetings(existing, [source]);
  const proposal = (result.aiSuggestion as Record<string, Record<string, unknown>>).budget;
  assert.equal(result.budget, existing.budget);
  assert.equal(result.items, existing.items);
  assert.equal(proposal.value, "80万円");
  assert.equal(proposal.quote, "");
  assert.equal(proposal.status, "estimated");
  assert.equal(proposal.source_meeting_id, source.id);
});

test("ignores malformed meetings and unknown field values", () => {
  const malformed: unknown[] = [null, [], false, "meeting", 0,
    meeting({ id: "" }), meeting({ meetingDate: "not-a-date" }),
    meeting({ id: 42 }), meeting({ meetingDate: new Date(NaN) }),
    meeting({ bantBudget: { value: "300万円" } }),
    meeting({ bantBudget: false }),
  ];
  assert.equal(findMeetingBantEvidence(malformed, "budget"), null);
  for (const existing of [null, [], true, "bad", 42, new Date()]) {
    assert.deepEqual(reconcileBantFromMeetings(existing, []), {});
  }
  assert.match(String(reconcileBantFromMeetings({ budget: 123, items: [] }, [meeting()]).budget), /300万円/u);
});

test("all-unknown input preserves an existing aggregate and never fabricates values", () => {
  const existing = { budget: "未確定", items: { budget: { value: "未確定", status: "unknown" } }, marker: "keep" };
  const sources = [meeting({ bantBudget: "未確認: 予算なし", bantAuthority: "未確定", bantNeed: "", bantTimeline: null })];
  assert.equal(reconcileBantFromMeetings(existing, sources), existing);
  assert.deepEqual(reconcileBantFromMeetings(null, sources), {});
});

test("recognizes unknown prefixes and preserves concrete nested values", () => {
  for (const value of [undefined, null, {}, [], 1, false, "", "  ", "未定", "未定：導入時期", "未確認: 予算なし", "未確定・決裁者", "未確定：時期", "確認できず"]) {
    assert.equal(isUnknownBantValue(value), true);
  }
  assert.equal(isUnknownBantValue("予算は300万円"), false);
  const existing = { items: { budget: { value: "既存200万円", status: "confirmed" } } };
  const result = reconcileBantFromMeetings(existing, [meeting()]);
  assert.deepEqual((result.items as Record<string, unknown>).budget, { ...existing.items.budget, status: "estimated", quote: "", source_meeting_id: "" });
  assert.equal(result.budget, "既存200万円");
});

test("unknown timeline placeholders are not promoted to evidence and manual values remain protected", () => {
  assert.equal(findMeetingBantEvidence([meeting({ bantTimeline: "未定" })], "timeline"), null);
  assert.equal(reconcileBantFromMeetings({ timeline: "未定" }, [meeting()]).timeline, "9月15日の経営会議で決裁");
  const manual = { timeline: "未定", manualFields: { timeline: true } };
  assert.equal(reconcileBantFromMeetings(manual, [meeting()]).timeline, "未定");
  assert.equal(isUnknownBantValue("9月導入を予定。具体的な日は未定。"), false);
});

test("a formerly undecided timeline is not replaced with older meeting evidence", () => {
  const timeline = "未定だったが、9月15日で合意した。";
  const item = { value: timeline, status: "confirmed", source_meeting_id: "latest-meeting", quote: "9月15日で合意した。" };
  const current = { timeline, items: { timeline: item } };
  assert.equal(isUnknownBantValue(timeline), false);
  const result = reconcileBantFromMeetings(current, [meeting({ bantTimeline: "10月以降に検討する" }), meeting({ id: "latest-meeting", meetingDate: "2026-09-01", transcript: item.quote, bantTimeline: timeline })]);
  assert.equal(result.timeline, timeline);
  assert.equal((result.items as Record<string, unknown>).timeline, item);
  assert.equal(findMeetingBantEvidence([meeting({ bantTimeline: timeline })], "timeline")?.value, timeline);
});

test("synchronizes a stale top-level placeholder from a concrete item without changing its evidence", () => {
  const item = {
    value: "300万円",
    status: "confirmed",
    source_meeting_id: "original-meeting",
    quote: "300万円を確保しました。",
  };
  for (const budget of [undefined, "", "未確認: 予算なし", "未確定: 予算を確認"]) {
    const existing = { budget, items: { budget: item }, custom: "keep" };
    const result = reconcileBantFromMeetings(existing, [meeting({ bantBudget: "別の240万円" }), meeting({ id: "original-meeting", meetingDate: "2026-08-30", transcript: item.quote })]);
    assert.equal(result.budget, "300万円");
    assert.equal((result.items as Record<string, unknown>).budget, item);
    assert.equal(result.custom, "keep");
    assert.equal(existing.budget, budget);
  }
  assert.equal(reconcileBantFromMeetings({ budget: "未確定", items: { budget: item } }, []).budget, "300万円");
});

test("does not synchronize nested evidence over an explicitly manual placeholder or a concrete top-level value", () => {
  const item = { value: "300万円", status: "confirmed", source_meeting_id: "original", quote: "300万円" };
  const manual = { budget: "未確認: 手動保留", manualFields: { budget: true }, items: { budget: item } };
  assert.equal(reconcileBantFromMeetings(manual, []).budget, manual.budget);
  const concrete = { budget: "確定200万円", items: { budget: item } };
  const result = reconcileBantFromMeetings(concrete, []);
  assert.equal(result.budget, concrete.budget);
  assert.equal((result.items as Record<string, { quote: string }>).budget.quote, "");
});

const manualKeys = ["budget", "authority", "need", "timeline"] as const;
function manualAggregate(aiSuggestion: Record<string, unknown> = {}) {
  const values = { budget: "以前に手入力した予算", authority: "以前の決裁者", need: "手入力の課題", timeline: "" };
  return {
    ...values,
    manualFields: Object.fromEntries(manualKeys.map((key) => [key, true])),
    items: Object.fromEntries(manualKeys.map((key) => [key, {
      value: values[key], status: "confirmed", source_meeting_id: "",
      quote: "User edited this BANT field manually.",
    }])),
    aiSuggestion,
    custom: { preserve: "metadata" },
    summary: "保持する総合所感",
    updatedBy: "manual",
  };
}

test("repairs copied manual proposals from the newest meeting without changing protected values or items", () => {
  const existing = manualAggregate();
  existing.aiSuggestion = { ...existing.items };
  const before = structuredClone(existing);
  Object.freeze(existing.items);
  Object.freeze(existing.aiSuggestion);
  Object.freeze(existing);
  const source = meeting({
    id: "newest", meetingDate: "2026-09-23T06:30:00Z",
    bantBudget: "80万円", bantAuthority: "人事部長の山田さん",
    bantNeed: "新卒採用への応募数不足", bantTimeline: "2027年3月希望",
    transcript: "予算は80万円。決裁者は人事部長の山田さん。新卒採用への応募数不足が課題。2027年3月希望。",
  });
  const result = reconcileBantFromMeetings(existing, [meeting(), source]);
  const suggestions = result.aiSuggestion as Record<string, { value: string; source_meeting_id: string; status: string; quote: string }>;
  for (const [key, field] of Object.entries({ budget: "bantBudget", authority: "bantAuthority", need: "bantNeed", timeline: "bantTimeline" })) {
    assert.equal(result[key], existing[key as typeof manualKeys[number]]);
    assert.equal(suggestions[key].value, source[field as keyof typeof source]);
    assert.equal(suggestions[key].source_meeting_id, "newest");
    assert.equal(suggestions[key].status, "estimated");
    assert.ok(source.transcript.includes(suggestions[key].quote));
  }
  assert.equal(result.timeline, "", "an explicitly cleared manual value stays blank");
  assert.equal(result.items, existing.items);
  assert.equal(result.manualFields, existing.manualFields);
  assert.equal(result.custom, existing.custom);
  assert.equal(result.summary, existing.summary);
  assert.deepEqual(existing, before);
});

test("retains valid cited proposals from recent transcript or minutes even when newer meeting values differ", () => {
  for (const source of [
    meeting({ transcript: "顧客: 予算は300万円です。", minutes: null }),
    meeting({ transcript: null, minutes: "顧客: 予算は300万円です。", sourceType: "manual_text", minutesJson: null }),
  ]) {
    const proposal = { value: "300万円を検討", status: "confirmed", source_meeting_id: source.id, quote: "予算は300万円です。" };
    const existing = manualAggregate({ budget: proposal });
    const result = reconcileBantFromMeetings(existing, [source, meeting({ id: "newer", meetingDate: "2026-09-01", bantBudget: "別の80万円" })]);
    assert.equal(result, existing);
    assert.equal((result.aiSuggestion as Record<string, unknown>).budget, proposal);
  }
});

test("retains an estimated exact meeting value without inventing a quote", () => {
  const source = meeting({ bantBudget: "予算300万円は承認待ち", transcript: "金額は社内で相談しています。", minutes: null });
  const proposal = { value: source.bantBudget, status: "estimated", source_meeting_id: source.id, quote: "" };
  const existing = manualAggregate({ budget: proposal });
  assert.equal(reconcileBantFromMeetings(existing, [source]), existing);
  const confirmed = manualAggregate({ budget: { ...proposal, status: "confirmed" } });
  const result = reconcileBantFromMeetings(confirmed, [source]);
  assert.deepEqual((result.aiSuggestion as Record<string, unknown>).budget, proposal);
});

test("repairs foreign-source, missing-source and nonliteral-quote proposals without trusting copied metadata", () => {
  const source = meeting({ bantBudget: "予算300万円を想定", transcript: "予算額は検討中です。", minutes: null });
  const invalid = [
    { value: "旧予算", status: "confirmed", source_meeting_id: "another-deal-meeting", quote: source.transcript },
    { value: "旧予算", status: "confirmed", source_meeting_id: "", quote: source.transcript },
    { value: "旧予算", status: "confirmed", source_meeting_id: source.id, quote: "原文に存在しない引用です。" },
    { value: source.bantBudget, status: "estimated", source_meeting_id: source.id, quote: "捏造した引用" },
    { value: "旧予算", status: "estimated", source_meeting_id: source.id, quote: "" },
    "出典のない古い文字列提案",
  ];
  for (const proposal of invalid) {
    const existing = manualAggregate({ budget: proposal });
    const result = reconcileBantFromMeetings(existing, [source]);
    const repaired = (result.aiSuggestion as Record<string, { value: string; quote: string; status: string; source_meeting_id: string }>).budget;
    assert.deepEqual(repaired, { value: source.bantBudget, status: "estimated", source_meeting_id: source.id, quote: "" });
    assert.equal(result.items, existing.items);
    assert.equal(existing.aiSuggestion.budget, proposal);
  }
});

test("removes an unsupported manual proposal when no concrete meeting evidence exists", () => {
  const source = meeting({ bantBudget: "未確認: 金額なし" });
  const invalid = { value: "以前の予算", status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." };
  const existing = manualAggregate({ budget: invalid, custom: { preserve: true } });
  const result = reconcileBantFromMeetings(existing, [source]);
  assert.deepEqual(result.aiSuggestion, { custom: { preserve: true } });
  assert.equal(result.items, existing.items);
  assert.equal(existing.aiSuggestion.budget, invalid);
  const onlyInvalid = manualAggregate({ budget: invalid });
  assert.equal("aiSuggestion" in reconcileBantFromMeetings(onlyInvalid, [source]), false);
  assert.equal(onlyInvalid.aiSuggestion.budget, invalid);
});

test("does not create a proposal just because protected manual fields have newer meeting evidence", () => {
  const existing: Record<string, unknown> = manualAggregate();
  delete existing.aiSuggestion;
  assert.equal(reconcileBantFromMeetings(existing, [meeting()]), existing);
  const empty = manualAggregate();
  assert.equal(reconcileBantFromMeetings(empty, [meeting()]), empty);
  assert.deepEqual(empty.aiSuggestion, {});
});

test("a source outside the latest five meetings cannot validate or replace a proposal", () => {
  const sources = Array.from({ length: 6 }, (_, index) => meeting({
    id: `source-${index}`, meetingDate: `2026-08-${String(31 - index).padStart(2, "0")}T01:00:00Z`,
    bantBudget: index === 5 ? "300万円" : "未確認: 金額なし", transcript: "予算は300万円です。",
  }));
  const existing = manualAggregate({ budget: { value: "300万円", status: "confirmed", source_meeting_id: "source-5", quote: "予算は300万円です。" } });
  const result = reconcileBantFromMeetings(existing, sources.reverse());
  assert.equal("aiSuggestion" in result, false);
  assert.equal(result.budget, existing.budget);
  assert.equal(result.items, existing.items);
});

test("repairing a manual proposal before filling a nonmanual field never mutates the original items", () => {
  const existing = {
    budget: "手動予算", authority: "未確認", need: "既存課題", timeline: "既存時期",
    manualFields: { budget: true },
    items: Object.freeze({ budget: { value: "手動予算", status: "unknown" } }),
    aiSuggestion: { budget: { value: "旧予算", source_meeting_id: "", quote: "User edited this BANT field manually." } },
  };
  const result = reconcileBantFromMeetings(existing, [meeting()]);
  assert.equal(result.authority, "最終決裁は代表取締役");
  assert.notEqual(result.items, existing.items);
  assert.equal((result.items as Record<string, unknown>).budget, existing.items.budget);
  assert.equal("authority" in existing.items, false);
  assert.equal(existing.authority, "未確認");
});

test("T06: a deal Timeline quote that only cites the withdrawal line is replaced by the meeting's evidence line", () => {
  const withdrawal = "顧客：前回は1月から使い始めたいとお話ししましたが、それは撤回します。";
  const evidence = "顧客：4月の新入研修に間に合えば十分です。";
  const transcript = ["営業：時期のご希望はありますか。", withdrawal, evidence, "営業：承知しました。では10月16日までに見積書と構成案をお送りします。"].join("\n");
  // A meeting analysed before the fix saved the withdrawal line as leading context.
  const source = meeting({ id: "rr", bantBudget: null, bantAuthority: null, bantNeed: null,
    bantTimeline: `文字起こし記載: ${withdrawal}\n${evidence}`, transcript });
  const value = "前回は1月から使い始めたいとお話ししましたが、それは撤回します。4月の新入研修に間に合えば十分です。";
  const timeline = { value, status: "estimated", source_meeting_id: "rr", quote: withdrawal };
  const result = reconcileBantFromMeetings({ timeline: value, items: { timeline } }, [source]);
  const repaired = (result.items as Record<string, Record<string, unknown>>).timeline;
  assert.equal(repaired.quote, evidence);
  assert.equal(repaired.value, value);
  assert.equal(repaired.source_meeting_id, "rr");
  // A quote that already contains the evidence line is kept as is.
  const kept = reconcileBantFromMeetings({ timeline: value, items: { timeline: { ...timeline, quote: evidence } } }, [source]);
  assert.equal((kept.items as Record<string, Record<string, unknown>>).timeline.quote, evidence);
  // Without a grounded evidence line in the meeting, the withdrawal line is dropped rather than shown as the source.
  const bare = meeting({ id: "rr", bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: `文字起こし記載: ${withdrawal}`, transcript });
  const dropped = reconcileBantFromMeetings({ timeline: value, items: { timeline } }, [bare]);
  assert.equal((dropped.items as Record<string, Record<string, unknown>>).timeline.quote, "");
});

// T18 C4（2026-10-01 再実行）: GET /api/deals/:id の bant と DB の deals.bant が JSON の文字列比較で一致しなかった。
// 保存時にも同じ補正をしているので内容は同じで、差はキーの順序だけ（Postgres の jsonb はキーを並べ替えて返す）。
// 読み取り時の補正は、すでに補正済みの値を作り直さない（同じオブジェクトを返す）。
test("withdrawal reconciliation of an already reconciled aggregate returns the stored object unchanged", () => {
  const latest = meeting({ id: "latest", meetingDate: "2026-10-01", bantBudget: BANT_UNKNOWN_VALUES.budget, bantTimeline: BANT_UNKNOWN_VALUES.timeline, bantNeed: "新卒採用の応募数不足",
    transcript: "営業：前回から、予算と導入時期、採用の課題に変更はありますか？\n顧客：前回の80万円という予算と2027年4月の導入希望は撤回します。現在、予算と導入時期は未定です。新卒採用の応募数不足という課題は引き続きあります。" });
  const old = meeting({ id: "old", meetingDate: "2026-09-30", bantBudget: "80万円を目安に検討。正式な社内承認は未取得。", bantTimeline: "2027年4月の導入を希望。正式日程は未確定。",
    transcript: "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。導入は2027年4月を希望します。" });
  const generated = { budget: "80万円を目安", timeline: "2027年4月", summary: "旧条件", confidence: 80, updatedBy: "auto",
    items: { budget: { value: "80万円を目安", status: "estimated", source_meeting_id: "old", quote: "" }, timeline: { value: "2027年4月", status: "estimated", source_meeting_id: "old", quote: "" } } };
  const saved = reconcileBantFromMeetings(generated, [latest, old]);
  assert.equal(saved.budget, BANT_UNKNOWN_VALUES.budget);
  assert.match(String(saved.summary), /予算の従来条件が撤回/);
  // jsonb 風にキーを並べ替えて読み戻しても、内容が同じなら作り直さない。
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).map((key) => [key, reorder((value as Record<string, unknown>)[key])])) : value;
  const stored = reorder(saved) as Record<string, unknown>;
  const reread = reconcileBantFromMeetings(stored, [latest, old]);
  assert.equal(reread, stored);
  assert.equal(JSON.stringify(reread), JSON.stringify(stored));
});
