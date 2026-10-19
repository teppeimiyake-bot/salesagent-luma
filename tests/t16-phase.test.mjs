import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const { deriveMeetPhase } = require("../src/lib/meetings/meet-phase.ts");
const { MeetSessionPanel } = require("../src/components/deals/meet-session-panel.tsx");
const { MeetingRecorder } = require("../src/components/deals/meeting-recorder.tsx");
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime");

const futureMeeting = {
  meetUrl: null,
  meetingStartAt: new Date("2026-09-24T01:00:00Z"),
  meetingEndAt: new Date("2026-09-24T02:00:00Z"),
  configStatus: null,
  artifactStatus: null,
  latestMeetingStatus: null,
  now: new Date("2026-09-23T01:00:00Z"),
};

function renderPanel(input) {
  return renderToStaticMarkup(createElement(MeetSessionPanel, {
    dealId: "demo",
    enabled: true,
    canEdit: true,
    initial: {
      meetUrl: input.meetUrl,
      meetSpaceName: null,
      configStatus: input.configStatus,
      configError: null,
      artifactStatus: input.artifactStatus,
      artifactError: null,
      attempts: 0,
      checkedAt: null,
      conferenceRecordId: null,
      latestMeetingId: null,
      phase: deriveMeetPhase(input),
    },
  }));
}

test("T16 future meeting without a URL is visibly unissued and cannot fetch artifacts", () => {
  for (const meetUrl of [null, ""]) {
    const input = { ...futureMeeting, meetUrl };
    assert.equal(deriveMeetPhase(input), "scheduled_unissued");
    const html = renderPanel(input);
    assert.match(html, /商談前（Meet未発行）/);
    assert.doesNotMatch(html, /商談前（Meet発行済み）/);
    assert.match(html, /Meet URLがまだ発行されていません/);
    const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)];
    assert.equal(buttons.length, 2);
    for (const [, attributes, content] of buttons) {
      assert.match(attributes, /\bdisabled=""/);
      assert.match(content, /設定を再試行|成果物を取得/);
    }
  }
});

test("T16 future meeting with a URL keeps the issued heading and participation link", () => {
  const input = { ...futureMeeting, meetUrl: "https://meet.google.com/abc-defg-hij" };
  assert.equal(deriveMeetPhase(input), "scheduled");
  const html = renderPanel(input);
  assert.match(html, /商談前（Meet発行済み）/);
  assert.doesNotMatch(html, /商談前（Meet未発行）/);
  assert.match(html, /href="https:\/\/meet.google.com\/abc-defg-hij"[^>]*>Meetに参加<\/a>/);
});

test("T16 missing URL preserves unscheduled, live and ended date boundaries", () => {
  for (const field of ["meetingStartAt", "meetingEndAt"]) {
    assert.equal(deriveMeetPhase({ ...futureMeeting, [field]: null }), "no_schedule");
  }
  assert.equal(deriveMeetPhase({ ...futureMeeting, now: futureMeeting.meetingStartAt }), "in_progress");
  assert.equal(deriveMeetPhase({ ...futureMeeting, now: futureMeeting.meetingEndAt }), "waiting_artifacts");
});

test("T16 missing URL does not override configuration or artifact processing results", () => {
  const cases = [
    [{ configStatus: "configured" }, "configured"],
    [{ configStatus: "failed" }, "config_failed"],
    [{ configStatus: "failed", now: futureMeeting.meetingEndAt }, "needs_attention"],
    [{ artifactStatus: "failed" }, "needs_attention"],
    [{ artifactStatus: "fetching" }, "fetching"],
    [{ artifactStatus: "fetched" }, "analyzing"],
    [{ latestMeetingStatus: "transcribed" }, "analyzing"],
    [{ latestMeetingStatus: "analyzing" }, "analyzing"],
    [{ latestMeetingStatus: "error" }, "needs_attention"],
    [{ latestMeetingStatus: "completed", configStatus: "failed", artifactStatus: "failed" }, "completed"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(deriveMeetPhase({ ...futureMeeting, ...overrides }), expected, JSON.stringify(overrides));
  }
});

test("T16 AC8 browser recorder has no Meet join-and-record shortcut and no pointer to it", () => {
  const router = { refresh() {}, push() {}, replace() {}, prefetch() {}, back() {}, forward() {} };
  // 旧呼び出し（Meet URL＋ショートカット指定）を渡しても、自社Meet向けの録音導線は出ない
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(MeetingRecorder, { dealId: "demo", meetUrl: "https://meet.google.com/abc-defg-hij", showMeetShortcut: true })));
  assert.doesNotMatch(html, /Meetに参加して録音開始|Meet URL未発行|meet\.google\.com/);
  assert.doesNotMatch(html, /上のMeetボタン/);
  assert.match(html, /マイクのみで録音します。オンライン会議で相手の声も録る場合はタブ音声を使ってください。/);
  // 対面・先方会議の例外経路（マイク／タブ音声の切替と録音開始）は残る
  for (const label of ["マイクのみ", "タブ音声", "録音開始"]) assert.match(html, new RegExp(`${label}</button>`));
});

test("T16 a deal still waiting past the cron's 7-day window needs attention; the boundary matches the cron query", () => {
  const { MEET_ARTIFACT_LOOKBACK_DAYS, MEET_ARTIFACT_LOOKBACK_MS, meetArtifactAutoFetchGiveUp } = require("../src/lib/meetings/meet-phase.ts");
  assert.equal(MEET_ARTIFACT_LOOKBACK_DAYS, 7);
  assert.equal(MEET_ARTIFACT_LOOKBACK_MS, 7 * 86400000);
  const ended = { ...futureMeeting, meetUrl: "https://meet.google.com/abc-defg-hij", meetEventId: "events/demo", configStatus: "configured" };
  // The cron still picks meetingEndAt == now - 7 days (gte); one millisecond later it never will.
  const atBoundary = new Date(ended.meetingEndAt.getTime() + MEET_ARTIFACT_LOOKBACK_MS);
  const pastBoundary = new Date(atBoundary.getTime() + 1);
  for (const artifactStatus of [null, "waiting"]) {
    assert.equal(deriveMeetPhase({ ...ended, artifactStatus, now: atBoundary }), "waiting_artifacts", String(artifactStatus));
    assert.equal(deriveMeetPhase({ ...ended, artifactStatus, now: pastBoundary }), "needs_attention", String(artifactStatus));
  }
  assert.equal(deriveMeetPhase({ ...ended, artifactStatus: "fetching", now: atBoundary }), "fetching");
  assert.equal(deriveMeetPhase({ ...ended, artifactStatus: "fetching", now: pastBoundary }), "needs_attention");
  // Results that are not a wait keep their own phase; an imported meeting's analysis state still wins.
  const cases = [
    [{ artifactStatus: "fetched" }, "analyzing"],
    [{ artifactStatus: "failed" }, "needs_attention"],
    [{ artifactStatus: "waiting", latestMeetingStatus: "completed" }, "completed"],
    [{ artifactStatus: "waiting", latestMeetingStatus: "analyzing" }, "analyzing"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(deriveMeetPhase({ ...ended, ...overrides, now: pastBoundary }), expected, JSON.stringify(overrides));
  }
  assert.equal(meetArtifactAutoFetchGiveUp({ ...ended, meetingEndAt: null, artifactStatus: "waiting", now: pastBoundary }), null);
  assert.equal(meetArtifactAutoFetchGiveUp({ ...ended, artifactStatus: "fetched", now: pastBoundary }), null);
  assert.equal(meetArtifactAutoFetchGiveUp({ ...ended, artifactStatus: "waiting", now: pastBoundary }), "lookback_expired");
});

const issuedEnded = {
  ...futureMeeting,
  meetUrl: "https://meet.google.com/abc-defg-hij",
  meetEventId: "events/demo",
  configStatus: "configured",
  artifactStatus: "waiting",
  attempts: 3,
  now: new Date("2026-09-24T03:00:00Z"),
};

test("T16 only a Meet the cron can pick (URL and Calendar event) is ever given up", () => {
  const { meetArtifactAutoFetchGiveUp, MEET_ARTIFACT_MAX_ATTEMPTS } = require("../src/lib/meetings/meet-phase.ts");
  const expired = { ...issuedEnded, now: new Date("2026-10-02T03:00:00Z") };
  const exhausted = { ...issuedEnded, attempts: MEET_ARTIFACT_MAX_ATTEMPTS };
  for (const input of [expired, exhausted]) {
    assert.equal(deriveMeetPhase(input), "needs_attention");
    for (const issue of [{ meetUrl: null }, { meetUrl: "" }, { meetEventId: null }, { meetEventId: undefined }]) {
      const unissued = { ...input, ...issue };
      assert.equal(meetArtifactAutoFetchGiveUp(unissued), null, JSON.stringify(issue));
      assert.equal(deriveMeetPhase(unissued), "waiting_artifacts", JSON.stringify(issue));
    }
  }
  // Without the new optional inputs (e.g. scripts/check-t16-meet.mts) the phase is what it always was.
  const legacy = { ...futureMeeting, meetUrl: "https://meet.google.com/abc-defg-hij", artifactStatus: "waiting", now: expired.now };
  assert.equal(deriveMeetPhase(legacy), "waiting_artifacts");
});

test("T16 the stored count at the limit gives up waiting, fetching and untouched rows; a fetch in progress is not given up", () => {
  const { meetArtifactAutoFetchGiveUp, MEET_ARTIFACT_MAX_ATTEMPTS, MEET_ARTIFACT_FETCH_STALE_MS } = require("../src/lib/meetings/meet-phase.ts");
  assert.equal(MEET_ARTIFACT_MAX_ATTEMPTS, 20);
  assert.equal(MEET_ARTIFACT_FETCH_STALE_MS, 10 * 60000);
  const atLimit = { ...issuedEnded, attempts: MEET_ARTIFACT_MAX_ATTEMPTS };
  assert.equal(deriveMeetPhase({ ...atLimit, attempts: MEET_ARTIFACT_MAX_ATTEMPTS - 1 }), "waiting_artifacts");
  for (const artifactStatus of [null, "waiting", "fetching"]) {
    assert.equal(meetArtifactAutoFetchGiveUp({ ...atLimit, artifactStatus }), "attempts_exhausted", String(artifactStatus));
    assert.equal(deriveMeetPhase({ ...atLimit, artifactStatus }), "needs_attention", String(artifactStatus));
  }
  // A start-only deal is never picked by the cron in the first place (the ingest keeps it waiting): not a give-up.
  assert.equal(meetArtifactAutoFetchGiveUp({ ...atLimit, meetingEndAt: null }), null);
  // fetching: in progress until MEET_ARTIFACT_FETCH_STALE_MS after the last check, then treated as a crashed attempt.
  const checkedAt = new Date(atLimit.now.getTime() - MEET_ARTIFACT_FETCH_STALE_MS + 1);
  assert.equal(deriveMeetPhase({ ...atLimit, artifactStatus: "fetching", checkedAt }), "fetching");
  assert.equal(deriveMeetPhase({ ...atLimit, artifactStatus: "fetching", checkedAt: new Date(checkedAt.getTime() - 1) }), "needs_attention");
  // The same holds past the 7-day window: a manual fetch running there is shown as fetching.
  const late = { ...atLimit, attempts: 3, artifactStatus: "fetching", now: new Date("2026-10-02T03:00:00Z") };
  assert.equal(deriveMeetPhase({ ...late, checkedAt: new Date(late.now.getTime() - 60000) }), "fetching");
  assert.equal(deriveMeetPhase({ ...late, checkedAt: null }), "needs_attention");
});

test("T16 the stored give-up is told apart from a real fetch error", () => {
  const { meetArtifactAutoFetchGiveUp, isMeetArtifactAttemptsExhaustedFailure, MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE } = require("../src/lib/meetings/meet-phase.ts");
  const stored = { ...issuedEnded, artifactStatus: "failed", artifactError: MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE, attempts: 20 };
  assert.equal(isMeetArtifactAttemptsExhaustedFailure(stored), true);
  assert.equal(meetArtifactAutoFetchGiveUp(stored), "attempts_exhausted");
  const realError = { ...stored, artifactError: "権限がありません" };
  assert.equal(isMeetArtifactAttemptsExhaustedFailure(realError), false);
  assert.equal(meetArtifactAutoFetchGiveUp(realError), null);
  assert.equal(isMeetArtifactAttemptsExhaustedFailure({ ...stored, artifactStatus: "waiting" }), false);
  for (const input of [stored, realError]) assert.equal(deriveMeetPhase(input), "needs_attention");
});

test("T16 another route's record turns a give-up into its processing state, but never hides a real error", () => {
  const { MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE } = require("../src/lib/meetings/meet-phase.ts");
  const givenUp = [
    { ...issuedEnded, now: new Date("2026-10-02T03:00:00Z") },
    { ...issuedEnded, attempts: 20 },
    { ...issuedEnded, artifactStatus: "failed", artifactError: MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE, attempts: 20 },
  ];
  const expected = [["completed", "completed"], ["analyzing", "analyzing"], ["transcribed", "analyzing"], ["transcribing", "analyzing"], ["uploaded", "analyzing"], ["error", "needs_attention"], [null, "needs_attention"]];
  for (const input of givenUp) {
    for (const [otherRouteMeetingStatus, phase] of expected) {
      assert.equal(deriveMeetPhase({ ...input, otherRouteMeetingStatus }), phase, `${input.artifactStatus}:${otherRouteMeetingStatus}`);
    }
  }
  // Not a give-up: a real error, and a wait the cron still handles.
  assert.equal(deriveMeetPhase({ ...givenUp[2], artifactError: "権限がありません", otherRouteMeetingStatus: "completed" }), "needs_attention");
  assert.equal(deriveMeetPhase({ ...issuedEnded, otherRouteMeetingStatus: "completed" }), "waiting_artifacts");
  // An imported Meet meeting still decides first.
  assert.equal(deriveMeetPhase({ ...givenUp[1], latestMeetingStatus: "analyzing", otherRouteMeetingStatus: "completed" }), "analyzing");
});

test("T16 panel shows a given-up automatic fetch as needing attention with the reason and a working manual fetch", () => {
  const { MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE } = require("../src/lib/meetings/meet-phase.ts");
  const exhausted = "自動取得の上限に達しました。Meetの文字起こしが作られていない可能性があります。「成果物を取得」で再試行できます。";
  for (const artifactError of [exhausted, MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE]) {
    const html = renderToStaticMarkup(createElement(MeetSessionPanel, {
      dealId: "demo",
      enabled: true,
      canEdit: true,
      initial: {
        meetUrl: "https://meet.google.com/abc-defg-hij",
        meetSpaceName: "spaces/demo",
        configStatus: "configured",
        configError: null,
        artifactStatus: "failed",
        artifactError,
        attempts: 20,
        checkedAt: "2026-09-21T03:40:00.000Z",
        conferenceRecordId: null,
        latestMeetingId: null,
        phase: "needs_attention",
      },
    }));
    assert.match(html, /確認が必要です/);
    assert.doesNotMatch(html, /成果物待ち/);
    assert.match(html, /取得失敗/);
    assert.ok(html.includes(artifactError), artifactError);
    const fetchButton = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].find(([, , content]) => content.includes("成果物を取得"));
    assert.ok(fetchButton);
    assert.doesNotMatch(fetchButton[1], /\bdisabled=""/);
  }
});

// 2026-09-30 クラウド確認（meet-status B1）：打ち切り後に手入力のテキスト記録（manual_text）で救済すると、
// processingStatus の既定が completed でも AI分析は走っていない。バッジを「AI分析まで完了」にせず、
// 同じ画面の「AI分析未実施」「分析を実行」と食い違わないようにする。
test("T16 a rescue record without AI analysis is shown as recorded, not as analysed", () => {
  const { MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE } = require("../src/lib/meetings/meet-phase.ts");
  const givenUp = [
    { ...issuedEnded, now: new Date("2026-10-02T03:00:00Z") },
    { ...issuedEnded, artifactStatus: "failed", artifactError: MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE, attempts: 20 },
  ];
  for (const input of givenUp) {
    const rescued = { ...input, otherRouteMeetingStatus: "completed" };
    assert.equal(deriveMeetPhase({ ...rescued, otherRouteMeetingAnalyzed: false }), "recorded");
    assert.equal(deriveMeetPhase({ ...rescued, otherRouteMeetingAnalyzed: true }), "completed");
    // Still being processed / failed records are unaffected by the flag.
    assert.equal(deriveMeetPhase({ ...input, otherRouteMeetingStatus: "transcribing", otherRouteMeetingAnalyzed: false }), "analyzing");
    assert.equal(deriveMeetPhase({ ...input, otherRouteMeetingStatus: "error", otherRouteMeetingAnalyzed: false }), "needs_attention");
  }
  // A Meet import of the current schedule is decided by its own status as before.
  assert.equal(deriveMeetPhase({ ...givenUp[0], latestMeetingStatus: "completed", otherRouteMeetingStatus: "completed", otherRouteMeetingAnalyzed: false }), "completed");

  const html = renderPanel({ ...givenUp[0], meetUrl: "https://meet.google.com/abc-defg-hij", configStatus: "configured", artifactStatus: null,
    otherRouteMeetingStatus: "completed", otherRouteMeetingAnalyzed: false });
  assert.match(html, /記録あり（AI分析は未実施）/);
  assert.doesNotMatch(html, /AI分析まで完了|確認が必要です/);
  // The fourth step (成果物取得・AI分析) is the current one; the badge is not the success colour.
  assert.match(html, /font-medium text-zinc-900">成果物取得・AI分析/);
});
