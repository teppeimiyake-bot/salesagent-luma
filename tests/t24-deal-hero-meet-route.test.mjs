import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// T24/T21：自社Meetで発行した後に会議種別を先方Meet・Zoom・対面・未選択へ変えても deals.meet_url は残る。
// ヒーロー（商談ページ先頭の要約と主操作）が、その古い自社MeetのURLを参加先や自動記録の案内として出さないことを、
// 実際の DealHero を描画して確かめる。
const require = createRequire(import.meta.url);
const { DealHero } = require("../src/components/deals/deal-hero.tsx");
const { recordingRouteFor } = require("../src/lib/meetings/recording-route.ts");

const OLD_OWN_MEET = "https://meet.google.com/old-own-meet";
const PHASES = ["planning", "scheduled", "imminent", "live", "wrapup", "followup"];
const NOT_OWN_MEET = ["guest_meet", "zoom", "in_person", "unknown"];

function renderHero(owner, phase, meetUrl = OLD_OWN_MEET, routeOptions = {}, extra = {}) {
  return renderToStaticMarkup(createElement(DealHero, {
    dealId: "d1",
    companyId: "c1",
    companyName: "デモ株式会社",
    dealTitle: "デモ商談",
    status: "LEAD",
    phase,
    owner: null,
    meetingRangeLabel: phase === "planning" ? null : "2026/09/30（水） 14:00–15:00",
    meetUrl,
    nextAction: null,
    nextActionAt: null,
    industryLabel: null,
    fiscalMonth: null,
    hasMinutes: false,
    recordingRoute: recordingRouteFor(owner, routeOptions),
    backHref: "/deals",
    ...extra,
  }));
}

/** 主操作ボタンの文言と、その下の1行説明。 */
function primaryOf(html) {
  const label = /<(?:a|button)\b[^>]*>([^<]+)/.exec(html.slice(html.indexOf("lg:w-[320px]")))?.[1];
  const hint = /<p class="mt-1\.5 text-\[12px\][^"]*">([^<]+)<\/p>/.exec(html)?.[1];
  return { label, hint };
}

/** 場面ラベルの下の説明文（いま何をする時間か）と、左の「記録ルート」欄。 */
function captionOf(html) {
  return /<p class="mt-1 text-\[12\.5px\][^"]*">([^<]+)<\/p>/.exec(html)?.[1];
}
function routeBoxOf(html) {
  const box = html.slice(html.indexOf('data-testid="hero-recording-route"'));
  return box.slice(0, box.indexOf("</div></div>") + 1).replace(/<[^>]+>/g, "");
}

test("T24 stale own Meet URL is never offered as a join link or copy target outside own Meet", () => {
  for (const owner of NOT_OWN_MEET) for (const autoRecordEnabled of [true, false]) {
    for (const phase of PHASES) {
      const html = renderHero(owner, phase, OLD_OWN_MEET, { autoRecordEnabled });
      const where = `${owner}/${phase}/auto=${autoRecordEnabled}`;
      assert.doesNotMatch(html, /old-own-meet/, `${where}: 古い自社Meet URLが出ている`);
      assert.doesNotMatch(html, /target="_blank"/, `${where}: 外部リンクの主操作が出ている`);
      assert.doesNotMatch(html, /Meet URLをコピー/, `${where}: Meet URLのコピー欄が出ている`);
      // 自社Meetの参加・自動記録・Meet発行の案内（先方会議・対面では機能しない導線）
      assert.doesNotMatch(html, /Meetに参加|Zoomに参加|録音操作は不要|Google Meetを発行|発行までまとめて/, where);
    }
  }
});

test("T21 in-person keeps the microphone as the primary path during the meeting", () => {
  for (const phase of ["imminent", "live"]) {
    const html = renderHero("in_person", phase);
    assert.deepEqual(primaryOf(html), {
      label: "マイク録音を開く",
      hint: "ライブ商談録音の「マイクのみ」を使用します",
    }, phase);
    assert.match(html, /商談記録の「マイクのみ」で録音します/);
  }
  assert.equal(primaryOf(renderHero("in_person", "scheduled")).label, "事前準備を確認する");
});

test("T21 guest Meet and Zoom show manual-attachment guidance instead of a join button", () => {
  for (const owner of ["guest_meet", "zoom"]) {
    assert.deepEqual(primaryOf(renderHero(owner, "scheduled")), {
      label: "会議情報を確認する",
      hint: "先方から共有された会議URLと日時を確認します",
    }, owner);
    for (const phase of ["imminent", "live"]) {
      const html = renderHero(owner, phase);
      const primary = primaryOf(html);
      assert.equal(primary.label, "会議情報を確認する", `${owner}/${phase}`);
      assert.match(primary.hint, /自動記録は行わず、終了後に受領した成果物を手動添付します/, `${owner}/${phase}`);
      assert.match(html, /会議に参加し、終了後に受領した成果物を手動添付します/);
      assert.match(html, /先方から議事録・文字起こし・録画を受け取り、商談記録へ添付してください/);
    }
    // URLが無い（先方会議の通常状態）ときも同じ案内になる
    assert.deepEqual(primaryOf(renderHero(owner, "live", null)), primaryOf(renderHero(owner, "live")), owner);
  }
});

test("T21 saving the date does not promise a Meet for non-own meetings", () => {
  for (const owner of ["guest_meet", "zoom", "in_person"]) {
    assert.deepEqual(primaryOf(renderHero(owner, "planning")), {
      label: "商談日時を設定する",
      hint: "商談予定の管理と記録に使います。この会議種別ではMeetを発行しません",
    }, owner);
  }
  assert.equal(primaryOf(renderHero("own_meet", "planning")).hint, "日時を保存すると、Google Meetの発行までまとめて行えます");
});

test("T24 own Meet keeps its join link, copy row and issuance prompt", () => {
  for (const phase of ["imminent", "live"]) {
    const html = renderHero("own_meet", phase, OLD_OWN_MEET, { autoRecordEnabled: true });
    assert.match(html, /<a[^>]*href="https:\/\/meet\.google\.com\/old-own-meet"[^>]*target="_blank"[^>]*>Meetに参加する/, phase);
    assert.equal(primaryOf(html).hint, "新しいタブで開きます。Luma側の録音操作は不要です");
    assert.match(routeBoxOf(html), /自社発行Meet・自動記録/);
    assert.match(html, /meet\.google\.com\/old-own-meet<\/span>/, "コピー欄");
    assert.match(html, /aria-label="Meet URLをコピー"/);
    assert.equal(primaryOf(renderHero("own_meet", phase, null)).label, "Google Meetを発行する", phase);
  }
});

// T16：FEATURE_MEET_AUTO_RECORD OFF（既定値・切り戻し時）はMeet側で何も記録されない。
// 自社Meetの参加リンクは残しつつ、「録音操作は不要」「自動記録」とは言わず、従来のブラウザ録音（タブ音声）へ案内する。
test("T16 rollback: own Meet with auto-record off guides browser recording instead of auto recording", () => {
  const off = { autoRecordEnabled: false };
  for (const phase of PHASES) {
    const html = renderHero("own_meet", phase, OLD_OWN_MEET, off);
    assert.doesNotMatch(html, /録音操作は不要|自動記録|記録はLumaが引き受けます/, phase);
    assert.match(routeBoxOf(html), /自社発行Meet・ブラウザ録音/, phase);
    assert.match(routeBoxOf(html), /「ライブ商談録音」で「タブ音声」を選んで録音を開始/, phase);
  }
  for (const phase of ["imminent", "live"]) {
    const html = renderHero("own_meet", phase, OLD_OWN_MEET, off);
    assert.match(html, /<a[^>]*href="https:\/\/meet\.google\.com\/old-own-meet"[^>]*target="_blank"[^>]*>Meetに参加する/, phase);
    assert.equal(primaryOf(html).hint, "新しいタブで開きます。録音は商談記録の「ライブ商談録音」で「タブ音声」を選んで開始します");
    assert.equal(captionOf(html), "Meetに参加し、商談記録の「タブ音声」で録音します", phase);
    assert.match(html, /aria-label="Meet URLをコピー"/, `${phase}: 自社Meetのコピー欄は残す`);
    assert.equal(primaryOf(renderHero("own_meet", phase, null, off)).label, "Google Meetを発行する", phase);
  }
  assert.equal(captionOf(renderHero("own_meet", "wrapup", OLD_OWN_MEET, off)), "ブラウザ録音の保存・解析結果を確認します");
  // 自社Meetは、フラグOFFでも日時の保存でMeetを発行する
  assert.equal(primaryOf(renderHero("own_meet", "planning", OLD_OWN_MEET, off)).hint,
    "日時を保存すると、Google Meetの発行までまとめて行えます");
});

// T16（2026-09-30 meet-status A2）：自動取得を打ち切った（Meetセッションが「確認が必要です」の）商談で、
// 上部の要約が「終了直後／商談の記録を取り込んでいます」のままにならず、要対応として出ること。
test("T16 hero shows a given-up Meet record as 要対応 instead of 'importing the record'", () => {
  const { dealMeetNeedsAttention } = require("../src/lib/deal-phase.ts");
  const phaseLabel = (html) => /data-testid="hero-phase-label"[^>]*>([^<]+)</.exec(html)?.[1];
  for (const phase of ["wrapup", "followup"]) {
    assert.equal(dealMeetNeedsAttention(phase, "needs_attention"), true, phase);
    const html = renderHero("own_meet", phase, OLD_OWN_MEET, { autoRecordEnabled: true }, { meetNeedsAttention: true });
    assert.equal(phaseLabel(html), "要対応", phase);
    assert.equal(captionOf(html), "Meetの記録を自動で取り込めませんでした。商談記録で確認してください", phase);
    assert.doesNotMatch(html, /商談の記録を取り込んでいます|終了直後/, phase);
    assert.deepEqual(primaryOf(html), {
      label: "商談の記録を確認する",
      hint: "自動取得は終了しています。「成果物を取得」で再試行するか、記録を手動で添付します",
    }, phase);
  }
  // Before the meeting (e.g. a rescheduled next meeting) and in any other Meet state, the scene is not overridden.
  for (const phase of ["planning", "scheduled", "imminent", "live"]) assert.equal(dealMeetNeedsAttention(phase, "needs_attention"), false, phase);
  for (const meetPhase of [null, undefined, "waiting_artifacts", "fetching", "analyzing", "recorded", "completed"]) {
    assert.equal(dealMeetNeedsAttention("wrapup", meetPhase), false, String(meetPhase));
  }
  // Won and lost deals are closed: no 要対応 (the deals list uses the same rule).
  for (const status of ["WON", "LOST"]) assert.equal(dealMeetNeedsAttention("wrapup", "needs_attention", { status }), false, status);
  for (const status of ["LEAD", "HEARING", "PROPOSAL", "NEGOTIATION", "CLOSING", null]) {
    assert.equal(dealMeetNeedsAttention("followup", "needs_attention", { status }), true, String(status));
  }
  // Won only by a product's yomi (deals.status stays LEAD for Notion imports): the same 受注 as the deals list's 受注後 tab
  // (2026-10-01 recheck Y1). Any won product counts, with or without a category prefix; NG / ネタ / Cヨミ do not.
  const { isDealClosed } = require("../src/lib/deal-phase.ts");
  const { isWonDeal } = require("../src/lib/deal-aggregations.ts");
  const yomiCases = [[["【映像】受注"], true], [["Bヨミ", "受注"], true], [["締結済み"], true], [["【SNS】NG", "ネタ"], false], [["Cヨミ"], false], [[null], false], [[], false]];
  for (const [yomis, won] of yomiCases) {
    const products = yomis.map((yomiStatus) => ({ yomiStatus, productName: "p", amount: 0 }));
    assert.equal(isDealClosed({ status: "LEAD", products }), won, JSON.stringify(yomis));
    assert.equal(isDealClosed({ status: "LEAD", products }), isWonDeal(products), `一覧の受注後タブと一致: ${JSON.stringify(yomis)}`);
    assert.equal(dealMeetNeedsAttention("followup", "needs_attention", { status: "LEAD", products }), !won, JSON.stringify(yomis));
  }
  // Without the flag the hero keeps its usual wording.
  const usual = renderHero("own_meet", "wrapup", OLD_OWN_MEET, { autoRecordEnabled: true });
  assert.equal(phaseLabel(usual), "終了直後");
  assert.equal(captionOf(usual), "商談の記録を取り込んでいます");
});

test("T16 deal page passes the Meet panel's needs-attention state to the hero", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/app/(app)/deals/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const meetNeedsAttention = dealMeetNeedsAttention\(phase, meetSessionStatus\?\.phase, deal\);/);
  // deal carries products with yomiStatus (the same rows the deals list judges 受注 from).
  assert.match(page, /products: \{\s*include:/);
  assert.match(page, /meetNeedsAttention=\{meetNeedsAttention\}/);
});
