import assert from "node:assert/strict";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";

const entry = "src/app/api/meetings/route.ts";
const dealId = "00000000-0000-4000-8000-000000000001";
const meetingDate = "2026-09-25T05:00:00.000Z";
const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);",
  "@/lib/storage": "export class StorageConfigError extends Error {};export const putFile=async()=>{throw Error('Storage must not run for a manual record')};",
  "@/lib/meetings/processing": "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBED:'transcribed',COMPLETED:'completed'};export const scheduleMeetingTranscription=async()=>{throw Error('Transcription must not run for a manual record')};",
  "@/lib/meetings/attachment-text": "export const extractAttachmentText=()=>{throw Error('Attachment extraction must not run for a manual record')};",
  "@/lib/meetings/transcription-job":"export const isTranscriptionJobMode=()=>mocks.jobMode===true;",
  "@/lib/meetings/audio-segments":"export const mediaToolsAvailable=async()=>mocks.mediaTools!==false;",
};

async function setup() {
  const state = {
    session: { userId: "demo" },
    permission: "user",
    target: { deletedAt: null, company: { deletedAt: null } },
    queries: [],
    created: [],
  };
  state.prisma = {
    user: { findUnique: async () => ({ permission: state.permission }) },
    deal: { findUnique: async (query) => { state.queries.push(query); return state.target; } },
    meeting: { create: async ({ data }) => {
      state.created.push(data);
      return { id: "created-meeting", ...data };
    } },
  };
  const route = await offlineModule(entry, state, boundaries,
    [entry, "src/lib/meetings/upload-formats.ts"], ["next/server", "zod", "node:crypto"]);
  state.post = (body) => route.POST(new Request("http://offline.invalid/api/meetings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  state.postMalformed = () => route.POST(new Request("http://offline.invalid/api/meetings", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{",
  }));
  return state;
}

test("T05 explicit blank manual record creates its label and date in one write without AI", async () => {
  const state = await setup();
  const response = await state.post({ dealId, createDraft: true, title: "  T05確認用  ", meetingDate });
  assert.equal(response.status, 200);
  const { meeting } = await response.json();
  assert.equal(meeting.title, "T05確認用");
  assert.equal(meeting.meetingDate, meetingDate);
  assert.equal(meeting.minutes, null);
  assert.equal(meeting.transcript, null);
  assert.equal(meeting.sourceType, "manual_text");
  assert.equal(meeting.processingStatus, "completed");
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].meetingDate.toISOString(), meetingDate);
  assert.equal(state.queries[0].where.id, dealId);
});

test("T05 manual records can omit their optional label/date, or trim a blank label", async () => {
  const state = await setup();
  for (const title of [undefined, " \n\t "]) {
    const response = await state.post({ dealId, createDraft: true, title });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).meeting.title, null);
    assert.equal(state.created.at(-1).meetingDate, undefined);
  }
});

test("T22 text ingestion still rejects missing and whitespace-only bodies unless a manual draft is explicit", async () => {
  const state = await setup();
  for (const body of [{ dealId }, { dealId, title: "ラベルだけ" }, { dealId, minutes: " \n ", transcript: "\t" }]) {
    const response = await state.post(body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /本文を入力/);
  }
  assert.equal(state.queries.length, 0);
  assert.equal(state.created.length, 0);
});

test("T05 malformed draft markers, title types and excessive labels are rejected before any write", async () => {
  const state = await setup();
  const cases = [
    [{ createDraft: false }, /作成方法/],
    [{ createDraft: "true" }, /作成方法/],
    [{ createDraft: null }, /作成方法/],
    [{ title: 42 }, /ラベル/],
    [{ title: null }, /ラベル/],
    [{ title: "あ".repeat(201) }, /200文字/],
  ];
  for (const [invalid, expected] of cases) {
    const response = await state.post({ dealId, createDraft: true, ...invalid });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, expected);
  }
  assert.equal(state.created.length, 0);
});

test("T05 invalid date/deal/text inputs and malformed JSON have useful input errors", async () => {
  const state = await setup();
  for (const [invalid, expected] of [
    [{ meetingDate: "2026-09-25" }, /日時/],
    [{ meetingDate: "not-a-date" }, /日時/],
    [{ dealId: "not-a-uuid" }, /商談/],
    [{ minutes: 123 }, /議事録/],
    [{ transcript: {} }, /文字起こし/],
  ]) {
    const response = await state.post({ dealId, createDraft: true, ...invalid });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, expected);
  }
  const malformed = await state.postMalformed();
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /入力内容/);
  assert.equal(state.created.length, 0);
});

test("T05 blank manual records still require authentication and write permission", async () => {
  for (const [change, expected] of [
    [(state) => { state.session = null; }, 401],
    [(state) => { state.permission = "viewer"; }, 403],
  ]) {
    const state = await setup();
    change(state);
    assert.equal((await state.post({ dealId, createDraft: true })).status, expected);
    assert.equal(state.queries.length, 0);
    assert.equal(state.created.length, 0);
  }
});

test("T05 inaccessible or deleted deals/companies cannot receive manual records", async () => {
  const state = await setup();
  // Tenant isolation is owned by the scoped Prisma client. The route must reject its null result.
  for (const target of [
    null,
    { deletedAt: new Date(), company: { deletedAt: null } },
    { deletedAt: null, company: { deletedAt: new Date() } },
  ]) {
    state.target = target;
    assert.equal((await state.post({ dealId, createDraft: true })).status, 404);
  }
  assert.equal(state.created.length, 0);
});

test("T22 nonblank text ingestion keeps saving the original text without the draft marker", async () => {
  const state = await setup();
  const body = { dealId, minutes: "  予算80万円。  ", transcript: "  架空商談の本文\n" };
  const response = await state.post(body);
  assert.equal(response.status, 200);
  const { meeting } = await response.json();
  assert.equal(meeting.minutes, body.minutes);
  assert.equal(meeting.transcript, body.transcript);
  assert.equal(state.created.length, 1);
});
