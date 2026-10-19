import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { meetingCodeFromMeetUrl, normalizeTranscriptEntries } = require("../src/lib/google/meet-artifacts.ts") as typeof import("../src/lib/google/meet-artifacts");
const { deriveMeetPhase } = require("../src/lib/meetings/meet-phase.ts") as typeof import("../src/lib/meetings/meet-phase");

// --- 1) Meet URL から会議コードを取り出す ---
assert.equal(meetingCodeFromMeetUrl("https://meet.google.com/abc-mnop-xyz"), "abc-mnop-xyz");
assert.equal(meetingCodeFromMeetUrl("https://meet.google.com/abc-mnop-xyz?hs=1"), "abc-mnop-xyz");
assert.equal(meetingCodeFromMeetUrl("https://meet.google.com/abc-mnop-xyz/"), "abc-mnop-xyz");
assert.equal(meetingCodeFromMeetUrl("  https://meet.google.com/abc-mnop-xyz  "), "abc-mnop-xyz");
assert.equal(meetingCodeFromMeetUrl("https://zoom.us/j/123456789"), null);
assert.equal(meetingCodeFromMeetUrl("not a url"), null);
assert.equal(meetingCodeFromMeetUrl(""), null);
assert.equal(meetingCodeFromMeetUrl(null), null);

// --- 2) 文字起こしの正規化 ---
const names = new Map<string, string>([
  ["conferenceRecords/r1/participants/p1", "森 祐志郎"],
]);
const entries = [
  { participant: "conferenceRecords/r1/participants/p1", text: "本日はお時間ありがとうございます。", startTime: "2026-08-28T01:00:00Z", endTime: "2026-08-28T01:00:05Z" },
  { participant: "conferenceRecords/r1/participants/p2", text: " よろしくお願いします。 ", startTime: "2026-08-28T01:00:06Z", endTime: "2026-08-28T01:00:09Z" },
  { participant: "conferenceRecords/r1/participants/p3", text: "   ", startTime: null, endTime: null },
  { participant: "conferenceRecords/r1/participants/p3", text: "資料を共有します。", startTime: "2026-08-28T01:00:10Z", endTime: "2026-08-28T01:00:14Z" },
  { participant: "conferenceRecords/r1/participants/p2", text: "承知しました。", startTime: null, endTime: null },
];
const { segments, text } = normalizeTranscriptEntries(entries, names);

assert.equal(segments.length, 4, "空文の発言は捨てる");
assert.deepEqual(
  segments.map((s) => s.speaker),
  ["森 祐志郎", "話者1", "話者2", "話者1"],
  "解決できない参加者は出現順に話者N、同じ参加者は同じラベル",
);
assert.equal(segments[1].text, "よろしくお願いします。", "前後の空白は落とす");
assert.equal(segments[0].startAt, "2026-08-28T01:00:00Z");
assert.equal(segments[0].endAt, "2026-08-28T01:00:05Z");
assert.equal(segments[3].startAt, null);
assert.equal(
  text,
  [
    "森 祐志郎: 本日はお時間ありがとうございます。",
    "話者1: よろしくお願いします。",
    "話者2: 資料を共有します。",
    "話者1: 承知しました。",
  ].join("\n"),
  "AIパイプラインへ渡す素テキストは 話者名: 本文 を発言順に並べる",
);

const empty = normalizeTranscriptEntries([], new Map());
assert.deepEqual(empty.segments, []);
assert.equal(empty.text, "");

// --- 3) フェーズ判定 ---
const now = new Date("2026-08-28T05:00:00Z");
const base = {
  meetUrl: "https://meet.google.com/abc-mnop-xyz",
  meetingStartAt: new Date("2026-08-28T06:00:00Z"),
  meetingEndAt: new Date("2026-08-28T07:00:00Z"),
  configStatus: null as string | null,
  artifactStatus: null as string | null,
  latestMeetingStatus: null as string | null,
  now,
};

assert.equal(deriveMeetPhase({ ...base, meetingStartAt: null, meetingEndAt: null }), "no_schedule");
assert.equal(deriveMeetPhase(base), "scheduled");
assert.equal(deriveMeetPhase({ ...base, configStatus: "configured" }), "configured");
assert.equal(deriveMeetPhase({ ...base, configStatus: "failed" }), "config_failed");
assert.equal(
  deriveMeetPhase({
    ...base,
    configStatus: "configured",
    meetingStartAt: new Date("2026-08-28T04:30:00Z"),
    meetingEndAt: new Date("2026-08-28T05:30:00Z"),
  }),
  "in_progress",
);

const afterMeeting = {
  ...base,
  configStatus: "configured" as string | null,
  meetingStartAt: new Date("2026-08-28T03:00:00Z"),
  meetingEndAt: new Date("2026-08-28T04:00:00Z"),
};
assert.equal(deriveMeetPhase(afterMeeting), "waiting_artifacts");
assert.equal(deriveMeetPhase({ ...afterMeeting, artifactStatus: "waiting" }), "waiting_artifacts");
assert.equal(deriveMeetPhase({ ...afterMeeting, artifactStatus: "fetching" }), "fetching");
assert.equal(deriveMeetPhase({ ...afterMeeting, artifactStatus: "fetched" }), "analyzing");
assert.equal(
  deriveMeetPhase({ ...afterMeeting, artifactStatus: "fetched", latestMeetingStatus: "analyzing" }),
  "analyzing",
);
assert.equal(
  deriveMeetPhase({ ...afterMeeting, artifactStatus: "fetched", latestMeetingStatus: "completed" }),
  "completed",
);
assert.equal(
  deriveMeetPhase({ ...afterMeeting, artifactStatus: "fetched", latestMeetingStatus: "error" }),
  "needs_attention",
);
assert.equal(deriveMeetPhase({ ...afterMeeting, artifactStatus: "failed" }), "needs_attention");
assert.equal(deriveMeetPhase({ ...afterMeeting, configStatus: "failed" }), "needs_attention");

console.log(`T16 checks passed: Meet URL parsing (8 cases), transcript normalization (${segments.length} segments / 話者Nフォールバック), phase derivation (16 transitions)`);
