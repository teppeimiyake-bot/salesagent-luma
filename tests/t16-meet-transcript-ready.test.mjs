// T16: Google Meet の文字起こしは、会議のすべての文字起こしがそろってから読む。完成前に読むと発言の一覧がそろって
// いないことがある（2026-09-30 の実 Meet で、終了の約2.5分後に9件中8件）。文字起こしは停止・再開のたびに別になるので、
// 発言は開始順につなげる。Google API はモックで、外部通信はしない。本文は架空。
import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

const minutesAgo = n => new Date(Date.now() - n * 60 * 1000).toISOString();

async function load(mocks) {
  return offlineModule("src/lib/google/meet-artifacts.ts", mocks, {
    googleapis: "export const google={meet:()=>mocks.meet};",
    "./meet": "export class GoogleMeetOperationError extends Error{};export const createMeetOAuthClient=()=>({});",
  }, ["src/lib/google/meet-artifacts.ts", "src/lib/meetings/timed-transcript.ts"]);
}

/** transcripts: [{name,state,startTime,endTime,entries:[text…]}]. The list is served in pages of `listPage`. */
function meetMock(transcripts, listPage = 100) {
  const mocks = { entryReads: [] };
  mocks.meet = { conferenceRecords: {
    transcripts: {
      list: async ({ pageToken }) => {
        const from = Number(pageToken ?? 0);
        const page = transcripts.slice(from, from + listPage).map(t => Object.fromEntries(Object.entries(t).filter(([key]) => key !== "entries")));
        return { data: { transcripts: page, nextPageToken: from + listPage < transcripts.length ? String(from + listPage) : undefined } };
      },
      entries: { list: async ({ parent }) => {
        mocks.entryReads.push(parent);
        const t = transcripts.find(x => x.name === parent);
        return { data: { transcriptEntries: t.entries.map(text => ({ participant: "p/1", text })) } };
      } },
    },
    participants: { get: async () => ({ data: { signedinUser: { displayName: "森雄士郎" } } }) },
  } };
  return mocks;
}

test("the Meet OAuth scopes do not ask for Drive (the transcript is read through the Meet API)", async () => {
  const { MEET_OAUTH_SCOPES } = await load({});
  assert.equal(JSON.stringify(MEET_OAUTH_SCOPES), JSON.stringify([
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/meetings.space.created",
    "https://www.googleapis.com/auth/meetings.space.settings",
    "https://www.googleapis.com/auth/meetings.space.readonly",
  ]));
});

test("all transcripts must be complete, or ended 30 minutes ago (the conference end when a transcript has none)", async () => {
  const { transcriptsReady, TRANSCRIPT_COMPLETION_GRACE_MS } = await load({});
  assert.equal(TRANSCRIPT_COMPLETION_GRACE_MS, 30 * 60 * 1000);
  const now = Date.parse("2026-09-30T04:22:41Z");
  const at = min => new Date(now - min * 60 * 1000).toISOString();
  const done = { state: "FILE_GENERATED", endTime: at(5) };
  assert.equal(transcriptsReady([], at(5), now), false);
  assert.equal(transcriptsReady([done], at(5), now), true);
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: at(5) }], at(5), now), false, "ended 5 minutes ago: still being generated");
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: at(29) }], at(29), now), false);
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: at(30) }], at(30), now), true, "30 minutes after the end: use what is there");
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: null }], at(5), now), false);
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: null }], at(40), now), true, "no end time: counted from the conference end");
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: null }], null, now), false);
  assert.equal(transcriptsReady([{ state: "STARTED" }], at(5), now), false);
  assert.equal(transcriptsReady([{ state: "STARTED" }], at(45), now), true, "a transcript stuck after the conference ended");
  assert.equal(transcriptsReady([{ state: "STATE_UNSPECIFIED", endTime: at(60) }], at(60), now), true);
  // One pending transcript holds the whole conference: a completed fragment must not be read alone.
  assert.equal(transcriptsReady([done, { state: "ENDED", endTime: at(2) }], at(2), now), false);
  assert.equal(transcriptsReady([{ state: "ENDED", endTime: at(60) }, done], at(5), now), true);
});

test("fetchMeetTranscript waits for every transcript and joins their entries in order", async () => {
  // Not complete yet: nothing is read.
  const pending = meetMock([{ name: "t/1", state: "ENDED", endTime: minutesAgo(2), entries: ["では 10 月 10 日までに見積書をお送りします。"] }]);
  assert.equal(await (await load(pending)).fetchMeetTranscript("conferenceRecords/r", minutesAgo(1)), null);
  assert.deepEqual(pending.entryReads, []);

  // Transcription stopped and restarted: a completed fragment and the main transcript still being generated.
  const restarted = [
    { name: "t/1", state: "FILE_GENERATED", startTime: minutesAgo(20), endTime: minutesAgo(18), entries: ["本日はありがとうございます。"] },
    { name: "t/2", state: "ENDED", startTime: minutesAgo(17), endTime: minutesAgo(2), entries: ["では 10 月 10 日までに見積書をお送りします。", "はい、 10 月 17 日の 15 時で大丈夫です。"] },
  ];
  const waiting = meetMock(restarted);
  assert.equal(await (await load(waiting)).fetchMeetTranscript("conferenceRecords/r", minutesAgo(1)), null);
  assert.deepEqual(waiting.entryReads, []);
  const joined = meetMock([restarted[0], { ...restarted[1], state: "FILE_GENERATED" }]);
  const result = await (await load(joined)).fetchMeetTranscript("conferenceRecords/r", minutesAgo(1));
  assert.deepEqual(joined.entryReads, ["t/1", "t/2"]);
  assert.equal(result.text, "森雄士郎: 本日はありがとうございます。\n森雄士郎: では10月10日までに見積書をお送りします。\n森雄士郎: はい、10月17日の15時で大丈夫です。");
  assert.equal(result.transcriptName, "t/1");
  assert.equal(result.startTime, restarted[0].startTime);
  assert.equal(result.endTime, restarted[1].endTime);

  // An empty first transcript does not block the others.
  const emptyFirst = meetMock([{ name: "t/1", state: "FILE_GENERATED", entries: [] }, { name: "t/2", state: "FILE_GENERATED", entries: ["はい、 10 月 17 日の 15 時で大丈夫です。"] }]);
  assert.equal((await (await load(emptyFirst)).fetchMeetTranscript("conferenceRecords/r", minutesAgo(1))).text, "森雄士郎: はい、10月17日の15時で大丈夫です。");

  // More transcripts than one page of the list.
  const many = Array.from({ length: 3 }, (_, i) => ({ name: `t/${i + 1}`, state: "FILE_GENERATED", entries: [`${i + 1} 件目の発言です。`] }));
  const paged = meetMock(many, 2);
  assert.equal((await (await load(paged)).fetchMeetTranscript("conferenceRecords/r", minutesAgo(1))).text, "森雄士郎: 1件目の発言です。\n森雄士郎: 2件目の発言です。\n森雄士郎: 3件目の発言です。");

  // 30 minutes after the conference ended an unfinished transcript is read as it is.
  const late = meetMock([{ name: "t/1", state: "ENDED", endTime: null, entries: ["では 10 月 10 日までに見積書をお送りします。"] }]);
  assert.equal((await (await load(late)).fetchMeetTranscript("conferenceRecords/r", minutesAgo(31))).transcriptName, "t/1");

  assert.equal(await (await load(meetMock([]))).fetchMeetTranscript("conferenceRecords/r", minutesAgo(40)), null);
});
