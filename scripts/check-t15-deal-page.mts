/**
 * T15 商談ページUI/UX刷新：純粋ロジックの検証。
 *
 * check-t14-quote.mts と同じ流儀（node:assert / DBなし / 単一 console.log）。
 * UI そのものは目視レビュー対象だが、「いまどの場面か」「次に何を押すか」の判定は
 * 誤ると画面が嘘をつくため、ここで境界条件まで固定しておく。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { deriveDealPhase, deriveDealPrimaryAction, dealPhaseStepIndex, DEAL_PHASE_STEPS } =
  require("../src/lib/deal-phase.ts") as typeof import("../src/lib/deal-phase");
const { formatJstMeetingRange, toJstDateTimeInput } =
  require("../src/lib/meeting-datetime.ts") as typeof import("../src/lib/meeting-datetime");

// 基準時刻：2026-08-28（金）14:30 JST
const NOW = "2026-08-28T14:30:00+09:00";
const start = (t: string) => `2026-08-28T${t}:00+09:00`;

// ---- 場面判定 -------------------------------------------------------------
assert.equal(deriveDealPhase({ now: NOW }), "planning", "日時も履歴も無ければ planning");
assert.equal(
  deriveDealPhase({ now: NOW, meetingsCount: 2 }),
  "followup",
  "日時が無くても履歴があれば商談後として扱う",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: start("16:00"), meetingEndAt: start("17:00") }),
  "scheduled",
  "開始15分より前は scheduled",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: start("14:40"), meetingEndAt: start("15:40") }),
  "imminent",
  "開始15分前以内は imminent",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: start("14:45"), meetingEndAt: start("15:45") }),
  "imminent",
  "ちょうど15分前の境界は imminent 側",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: start("14:00"), meetingEndAt: start("15:00") }),
  "live",
  "開始〜終了のあいだは live",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: start("13:00"), meetingEndAt: start("14:00") }),
  "wrapup",
  "終了直後で議事録が無ければ wrapup",
);
assert.equal(
  deriveDealPhase({
    now: NOW,
    meetingStartAt: start("13:00"),
    meetingEndAt: start("14:00"),
    latestMeetingHasMinutes: true,
  }),
  "followup",
  "終了直後でも議事録が揃っていれば followup",
);
assert.equal(
  deriveDealPhase({
    now: NOW,
    meetingStartAt: start("16:00"),
    meetingEndAt: start("17:00"),
    latestMeetingStatus: "analyzing",
  }),
  "wrapup",
  "解析中は時刻より処理状態を優先する",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: start("13:00") }),
  "live",
  "終了時刻が無い商談は開始から2時間を仮の終了とみなす",
);
assert.equal(
  deriveDealPhase({
    now: NOW,
    meetingStartAt: "2026-08-01T10:00:00+09:00",
    meetingEndAt: "2026-08-01T11:00:00+09:00",
    meetingsCount: 1,
    latestMeetingHasMinutes: true,
  }),
  "followup",
  "だいぶ前に終わった商談で記録があれば followup",
);
assert.equal(
  deriveDealPhase({
    now: NOW,
    meetingStartAt: "2026-08-01T10:00:00+09:00",
    meetingEndAt: "2026-08-01T11:00:00+09:00",
    meetingsCount: 0,
  }),
  "wrapup",
  "だいぶ前に終わったのに記録が無いなら取りこぼしとして wrapup を維持する",
);
assert.equal(
  deriveDealPhase({ now: NOW, meetingStartAt: "not-a-date" }),
  "planning",
  "壊れた日時は無視して planning に倒す",
);

// ---- 主操作 ---------------------------------------------------------------
const MEET = "https://meet.google.com/abc-mnop-xyz";

const planning = deriveDealPrimaryAction("planning", { hasSchedule: false, hasMinutes: false });
assert.equal(planning.kind, "set_schedule");
assert.equal(planning.targetSectionId, "section-deal-status");
assert.equal(planning.href, null);

const scheduledNoMeet = deriveDealPrimaryAction("scheduled", { hasSchedule: true, hasMinutes: false });
assert.equal(scheduledNoMeet.kind, "issue_meet", "日時はあるがMeetが無ければ発行を促す");

const scheduledWithMeet = deriveDealPrimaryAction("scheduled", {
  meetUrl: MEET,
  hasSchedule: true,
  hasMinutes: false,
});
assert.equal(scheduledWithMeet.kind, "set_next_action", "Meetまで揃っていれば事前準備へ誘導する");

const live = deriveDealPrimaryAction("live", { meetUrl: MEET, hasSchedule: true, hasMinutes: false });
assert.equal(live.kind, "join_meet");
assert.equal(live.href, MEET, "商談中はMeet URLを直接開く");
assert.equal(live.targetSectionId, null);

const liveNoMeet = deriveDealPrimaryAction("live", { hasSchedule: true, hasMinutes: false });
assert.equal(liveNoMeet.kind, "issue_meet", "商談中でもMeetが無ければ発行導線を出す");

const wrapup = deriveDealPrimaryAction("wrapup", { meetUrl: MEET, hasSchedule: true, hasMinutes: false });
assert.equal(wrapup.kind, "collect_artifacts");
assert.equal(wrapup.targetSectionId, "group-record");

const followWithMinutes = deriveDealPrimaryAction("followup", { hasSchedule: true, hasMinutes: true });
assert.equal(followWithMinutes.kind, "review_minutes");
assert.equal(followWithMinutes.targetSectionId, "section-history");

const followNoMinutes = deriveDealPrimaryAction("followup", { hasSchedule: true, hasMinutes: false });
assert.equal(followNoMinutes.kind, "collect_artifacts");

// 主操作は常に1件で、遷移先はページ内アンカーか外部リンクのどちらか一方だけ。
for (const p of ["planning", "scheduled", "imminent", "live", "wrapup", "followup"] as const) {
  const a = deriveDealPrimaryAction(p, { meetUrl: MEET, hasSchedule: true, hasMinutes: false });
  assert.ok(a.label.length > 0, `${p}: ラベルが空`);
  assert.ok(a.hint.length > 0, `${p}: 押した先の説明が空`);
  assert.ok(
    (a.href == null) !== (a.targetSectionId == null),
    `${p}: 遷移先はページ内か外部のどちらか一方であること`,
  );
}

// ---- 進行表示 -------------------------------------------------------------
assert.equal(dealPhaseStepIndex("planning"), 0);
assert.equal(dealPhaseStepIndex("scheduled"), 0);
assert.equal(dealPhaseStepIndex("imminent"), 1);
assert.equal(dealPhaseStepIndex("live"), 1);
assert.equal(dealPhaseStepIndex("wrapup"), 2);
assert.equal(dealPhaseStepIndex("followup"), 3);
assert.equal(DEAL_PHASE_STEPS.length, 4);
// すべての場面がいずれかのステップに属すること（表示が欠ける場面を作らない）
for (const p of ["planning", "scheduled", "imminent", "live", "wrapup", "followup"] as const) {
  assert.ok(
    DEAL_PHASE_STEPS.some((s) => s.phases.includes(p)),
    `${p} がステップ表示から漏れている`,
  );
}

// ---- 商談日時の表示（JST固定・TZ非依存） ----------------------------------
assert.equal(
  formatJstMeetingRange("2026-08-28T05:00:00Z", "2026-08-28T06:00:00Z"),
  "2026/08/28（金） 14:00–15:00",
);
assert.equal(formatJstMeetingRange("2026-08-28T05:00:00Z", null), "2026/08/28（金） 14:00〜");
assert.equal(formatJstMeetingRange(null, null), null);
assert.equal(formatJstMeetingRange("こわれた値", null), null);
assert.equal(
  formatJstMeetingRange("2026-08-28T14:30:00Z", "2026-08-28T16:00:00Z"),
  "2026/08/28（金） 23:30–2026/08/29 01:00",
  "日をまたぐ場合は終了側も日付から書く",
);
// 既存ヘルパーとの整合（同じ +09:00 固定変換であること）
assert.equal(toJstDateTimeInput("2026-08-28T05:00:00Z"), "2026-08-28T14:00");

console.log(
  "T15 checks passed: 場面判定13件 / 主操作9件＋不変条件6件 / 進行表示10件 / JST日時表示6件",
);
