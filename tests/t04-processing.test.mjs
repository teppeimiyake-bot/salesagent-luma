import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
import { LONG_ANALYSIS_PURE_MODULES } from "./helpers/long-analysis-modules.mjs";
const entry = "src/lib/meetings/processing.ts";
const statusEntry = "src/app/api/meetings/[id]/status/route.ts";
function setup() {
  const row = { id: "meeting", recordingUrl: "/uploads/demo.webm", audioSizeBytes: 20*1024*1024, durationSec: 5400, processingStatus: "uploaded", transcript: null, meta: { original: true } };
  const m = { row, calls: 0, cleaned: [], env: { NODE_ENV: "development" }, session: {userId:"demo"}, permission:"user", scheduled:0 };
  m.prisma = { user: {findUnique: async()=>({permission:m.permission})}, meeting: {
    findUnique: async()=>m.row,
    updateMany: async({where,data})=> {if(!m.row || m.row.processingStatus!==where.processingStatus) return {count:0};Object.assign(row,data);return {count:1}},
    update: async({data})=>Object.assign(row,data),
  }};
  m.fetchStored = async()=>({buffer:Buffer.from("mock audio")});
  m.transcribe = async()=>{m.calls++;return {text:" 検証用文字起こし ",metrics:{inputMode:"files_api"}}};
  return m;
}
const boundaries={
  "@/lib/db":"export const prisma=mocks.prisma;",
  "next/server":"export const after=fn=>mocks.after(fn);",
  "@/lib/ai/openai":"export const transcribeFileWithMetrics=(...a)=>mocks.transcribe(...a);",
  "@/lib/storage":"export const fetchStored=(...a)=>mocks.fetchStored(...a);export const writeTempFile=async()=>'/tmp/test.webm';export const cleanupTempFile=async p=>mocks.cleaned.push(p);",  "@/lib/meetings/transcription-job":"export const isTranscriptionJobMode=()=>mocks.jobMode===true;",
};
test("T04 90-minute metadata and large recording succeed and temp is cleaned",async()=>{
  const m=setup(),lib=await offlineModule(entry,m,boundaries);await lib.processMeetingTranscription("meeting");
  assert.equal(m.row.processingStatus,"transcribed");assert.equal(m.row.transcript,"検証用文字起こし");
  assert.equal(m.row.meta.original,true);assert.equal(m.row.meta.transcription.inputDurationSec,5400);assert.equal(m.cleaned.length,1);
});
test("T04 empty large-file output is an explicit error",async()=>{
  const m=setup();m.transcribe=async()=>({text:" ",metrics:{}});const lib=await offlineModule(entry,m,boundaries);
  await lib.processMeetingTranscription("meeting");assert.equal(m.row.processingStatus,"error");assert.match(m.row.processingError,/18MB/);assert.equal(m.cleaned.length,1);
});
test("T04 concurrent processing claims work only once",async()=>{
  const m=setup(),lib=await offlineModule(entry,m,boundaries);await Promise.all([lib.processMeetingTranscription("meeting"),lib.processMeetingTranscription("meeting")]);assert.equal(m.calls,1);
});
test("T04 missing recording and failed AI are visible",async()=>{
  for(const missing of [true,false]){const m=setup();if(missing)m.row.recordingUrl=null;else m.transcribe=async()=>{throw Error("simulated AI failure")};
    const lib=await offlineModule(entry,m,boundaries);await lib.processMeetingTranscription("meeting");assert.equal(m.row.processingStatus,"error");assert.ok(m.row.processingError);}
});
test("T04 completed transcription is not overwritten",async()=>{
  const m=setup();m.row.processingStatus="completed";m.row.transcript="existing";const lib=await offlineModule(entry,m,boundaries);await lib.processMeetingTranscription("meeting");assert.equal(m.calls,0);assert.equal(m.row.transcript,"existing");
});
const statusBoundaries={
  "@/lib/db":boundaries["@/lib/db"],
  "@/lib/auth":"export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);",
  "@/lib/meetings/processing":"export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded'};export const scheduleMeetingTranscription=async()=>{mocks.scheduled++};",
};
const statusAllowed=[statusEntry,"src/lib/meetings/status-payload.ts","src/lib/meetings/transcription-job.ts","src/lib/meetings/timed-transcript.ts",...LONG_ANALYSIS_PURE_MODULES];
const request=()=>new Request("http://offline.invalid",{method:"POST",body:JSON.stringify({action:"retry-transcription"})});
const params={params:Promise.resolve({id:"meeting"})};
test("T04 retry guards reject unauthenticated/read-only/in-flight/already-transcribed requests",async()=>{
  for(const [change,status] of [[m=>m.session=null,401],[m=>m.permission="viewer",403],[()=>{},409],[m=>{m.row.processingStatus="error";m.row.transcript="existing"},409]]){
    const m=setup();change(m);const route=await offlineModule(statusEntry,m,statusBoundaries,statusAllowed);assert.equal((await route.POST(request(),params)).status,status);assert.equal(m.scheduled,0);
  }
});
test("T04 retry error is queued once; status redacts transcript and file URL",async()=>{
  const m=setup();m.row.processingStatus="error";const route=await offlineModule(statusEntry,m,statusBoundaries,statusAllowed);
  assert.equal((await route.POST(request(),params)).status,202);assert.equal((await route.POST(request(),params)).status,409);assert.equal(m.scheduled,1);
  const json=await (await route.GET(new Request("http://offline.invalid"),params)).json();assert.equal(json.meeting.recordingUrl,undefined);assert.equal(json.meeting.transcript,undefined);assert.equal(json.meeting.hasRecording,true);
});
const uploadEntry="src/app/api/meetings/route.ts";
const uploadBoundaries={...statusBoundaries,
  "@/lib/meetings/processing":"export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBED:'transcribed',COMPLETED:'completed'};export const scheduleMeetingTranscription=async()=>{mocks.scheduled++};",
  "@/lib/storage":"export class StorageConfigError extends Error {};export const putFile=async()=>{mocks.stored++;return {url:'/uploads/test.webm'}};",
  "@/lib/meetings/attachment-text":"export const extractAttachmentText=()=> '架空会議の本文';",
  "@/lib/meetings/transcription-job":"export const isTranscriptionJobMode=()=>mocks.jobMode===true;",
  "@/lib/meetings/audio-segments":"export const mediaToolsAvailable=async()=>mocks.mediaTools!==false;",
};
test("T04 upload checks permission, target deal, file type and integer duration before storage",async()=>{
  for(const [change,status] of [[m=>m.permission="viewer",403],[m=>m.target=null,404],[m=>m.target.deletedAt=new Date(),404],[m=>m.file="invalid",400],[m=>m.duration="9999999999999999999",400],[()=>{},202]]){
    const m=setup();m.stored=0;m.target={deletedAt:null,company:{deletedAt:null}};m.file=new File(["audio"],"demo.webm");m.duration="3600";
    m.prisma.deal={findUnique:async()=>m.target};m.prisma.meeting.create=async({data})=>({id:"meeting",...data});change(m);
    const route=await offlineModule(uploadEntry,m,uploadBoundaries,[uploadEntry,"src/lib/meetings/upload-formats.ts"],["next/server","zod","node:crypto"]);
    const form=new FormData();form.set("dealId","00000000-0000-4000-8000-000000000001");form.set("file",m.file);form.set("durationSec",m.duration);
    assert.equal((await route.POST(new Request("http://offline.invalid",{method:"POST",body:form}))).status,status);
    assert.equal(m.stored,status===202?1:0);assert.equal(m.scheduled,status===202?1:0);
  }
});

test("T04 acceptance messages say processing continues after the screen is closed, not only while the deal is open", async () => {
  const { readFile } = await import("node:fs/promises");
  const recorder = await readFile(new URL("../src/components/deals/meeting-recorder.tsx", import.meta.url), "utf8");
  const upload = await readFile(new URL("../src/components/deals/upload-recording.tsx", import.meta.url), "utf8");
  for (const source of [recorder, upload]) {
    assert.doesNotMatch(source, /この商談を開いている間に処理します/u);
    assert.match(source, /受付完了。文字起こしと議事録・BANTの作成は自動で進みます。この画面を閉じても処理は続き、進捗と結果は下の「商談履歴」に表示されます。/u);
  }
  assert.match(upload, /受付完了。長い記録のため、関係する発言を原文のまま抜粋して分析します。進捗と結果は下の「商談履歴」に表示されます。/u);
});
