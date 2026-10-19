import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
import { LONG_ANALYSIS_PURE_MODULES } from "./helpers/long-analysis-modules.mjs";
const entry="src/lib/meetings/analysis.ts";
// 長い記録の分岐（ジョブ方式のみ）は実物の純関数を使う。この環境（NODE_ENV=development）では従来どおりの分析。
const allowed=[entry,"src/lib/meetings/transcription-job.ts","src/lib/meetings/timed-transcript.ts",...LONG_ANALYSIS_PURE_MODULES];
const boundaries={
  "@/lib/db":"export const prisma=mocks.prisma;",
  "@/lib/ai/pipeline":"export const runPipeline=(...a)=>mocks.pipeline(...a);",
  "@/lib/meetings/processing":"export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBING:'transcribing',ANALYZING:'analyzing',ERROR:'error',COMPLETED:'completed'};",
  "@/lib/feature-flags":"export const isAutoBantFeatureEnabled=()=>true;",
  "@/lib/ai/summarize-bant":"export const scheduleDealBantSummary=async()=>{mocks.bant++};",
  "@/lib/meetings/status-payload":"export const isAnalysisStalled=()=>false;",
};
function setup() {
  const row={id:"meeting",dealId:"deal",minutes:null,transcript:"架空顧客の発言",processingStatus:"transcribed",meta:{transcription:{elapsedMs:1200}},
    deal:{title:"架空商談",company:{name:"架空企業"},products:[]}};
  const m={row,bant:0,calls:0};
  m.prisma={meeting:{findUnique:async()=>structuredClone(row),update:async({data})=>Object.assign(row,data),updateMany:async({where,data})=>{
    if(Object.entries(where).some(([k,v])=>row[k]!==v))return {count:0};Object.assign(row,data);return {count:1};
  }},aiLog:{findMany:async()=>[],create:async()=>({})},deal:{update:async()=>({})}};
  m.pipeline=async()=>{m.calls++;return {meetingMinutes:{markdown:"## 参加者\n架空担当者",json:{},usedFallback:false},topSales:{real_intent:"意図",winning_scenario:"仮説"},
    analysis:{issues:[],bant:{budget:"未確認",authority:"未確認",need:"採用",timeline:"未確認"}},nextActions:{next_actions:[]},trace:[],structured:{},strategy:{},scores:{},fallback:false,improved:false}};
  return m;
}
test("T05 saves generated minutes and preserves transcription metrics",async()=>{
  const m=setup(),lib=await offlineModule(entry,m,boundaries,allowed);assert.equal((await lib.runMeetingAnalysis("meeting")).ok,true);
 assert.match(m.row.minutes,/参加者/);assert.equal(m.row.meta.transcription.elapsedMs,1200);assert.equal(m.row.processingStatus,"completed");assert.equal(m.bant,1);
});
test("T05 persists guarded recommendations and trace, and clears a stale guard marker on a later concrete Need",async()=>{
 for (const applied of [true,false]) {
  const m=setup(),logs=[];
  m.row.meta.recommendationGuard="unconfirmed-need";
  m.prisma.aiLog.create=async({data})=>{logs.push(data);return {};};
  const original=m.pipeline;
  const nextActions={next_actions:[{action:applied?"課題と未確認条件を確認する質問を作成する":"9月30日までに見積を送付する"}]};
  const scores={scores:applied?{actionability:3,specificity:3,impact:2}:{actionability:5,specificity:5,impact:4}};
  const draft={step:"step5_next_actions",input:{},output:{next_actions:[{action:"元のAI案"}]}};
  const guard={step:"evidence_guard_unconfirmed_need",input:{promptVersion:"20260923-evidence-first-v5"},output:{nextActions,scores,applied:true}};
  m.pipeline=async()=>({...await original(),nextActions,scores,recommendationGuard:applied?"unconfirmed-need":undefined,trace:applied?[draft,guard]:[draft]});
  const lib=await offlineModule(entry,m,boundaries,allowed);
  assert.equal((await lib.runMeetingAnalysis("meeting")).ok,true);
  assert.equal(m.row.meta.recommendationGuard,applied?"unconfirmed-need":null);
  assert.equal(m.row.meta.transcription.elapsedMs,1200);
  assert.equal(m.row.nextActions,nextActions);
  assert.equal(m.row.scores,scores);
  assert.equal(logs[0].output,draft.output);
  assert.equal(logs.length,applied?2:1);
  if (applied) {
   assert.equal(logs[1].step,guard.step);
   assert.equal(logs[1].input.promptVersion,"20260923-evidence-first-v5");
   assert.equal(logs[1].output,guard.output);
  }
 }
});
test("T05 preserves human minutes before and during AI generation",async()=>{
  for(const during of [false,true]){const m=setup();if(during){const pipeline=m.pipeline;m.pipeline=async()=>{m.row.minutes="人の編集";return pipeline()}}else m.row.minutes="人の編集";
    const lib=await offlineModule(entry,m,boundaries,allowed);await lib.runMeetingAnalysis("meeting");assert.equal(m.row.minutes,"人の編集");}
});
test("T05 saves the grounded Timeline in both meeting fields and analysis while retaining its raw draft audit",async()=>{
 const m=setup(),logs=[];
 const original=m.pipeline;
 const value="未確定: 導入時期を確認する必要あり";
 const draft={step:"step2_analysis_draft",input:{},output:{bant:{timeline:"検討段階ではない"},timeline_source_ids:[]}};
 const guard={step:"evidence_guard_timeline",input:{rawTimeline:draft.output.bant.timeline},output:{value,sourceIds:[],sourceQuotes:[],rejectedSourceIds:[]}};
 m.pipeline=async()=>{const result=await original();return {...result,analysis:{...result.analysis,bant:{...result.analysis.bant,timeline:value}},trace:[draft,guard]};};
 m.prisma.aiLog.create=async({data})=>{logs.push(data);return {};};
 const lib=await offlineModule(entry,m,boundaries,allowed);
 assert.equal((await lib.runMeetingAnalysis("meeting")).ok,true);
 assert.equal(m.row.bantTimeline,value);
 assert.equal(m.row.analysis.bant.timeline,value);
 assert.equal(logs[0].output,draft.output);
 assert.equal(logs[1].output,guard.output);
});
test("T05 rejects blank sources and uses minutes when transcript is whitespace",async()=>{
  const m=setup();m.row.transcript="  ";const lib=await offlineModule(entry,m,boundaries,allowed);
  assert.equal((await lib.runMeetingAnalysis("meeting")).kind,"empty");assert.equal(m.calls,0);
  m.row.minutes="手動の本文";assert.equal((await lib.runMeetingAnalysis("meeting")).ok,true);
});
test("T05 concurrent analyses invoke AI once and failures remain visible",async()=>{
  const m=setup(),lib=await offlineModule(entry,m,boundaries,allowed);await Promise.all([lib.runMeetingAnalysis("meeting"),lib.runMeetingAnalysis("meeting")]);assert.equal(m.calls,1);
  m.pipeline=async()=>{throw Error("simulated failure")};assert.equal((await lib.runMeetingAnalysis("meeting")).kind,"failed");assert.equal(m.row.processingStatus,"error");
});
test("T05 audio byte ranges support seeking and suffix requests",async()=>{
  const e="src/app/api/meetings/[id]/recording/route.ts";
  const m={prisma:{meeting:{findUnique:async()=>({recordingUrl:"/demo"})}},session:{userId:"demo"}};
  const route=await offlineModule(e,m,{"@/lib/db":boundaries["@/lib/db"],"@/lib/auth":"export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};",
    "@/lib/storage":"export const fetchStored=async()=>({buffer:Buffer.from('0123456789'),contentType:'audio/webm'});",
    "node:fs/promises":"export default {readFile:async()=>{throw Error('no playback audio')}};",
    "@/lib/meetings/transcription-job":"export const readTranscriptionJob=()=>null;",
    "@/lib/meetings/transcription-files":"export const playbackAudioPath=()=>null;",
    "@/lib/meetings/upload-sessions":"export const isUploadManifestKey=()=>false;"});
  for(const [range,status,text] of [["bytes=2-5",206,"2345"],["bytes=-3",206,"789"],["bytes=8-",206,"89"],["bytes=-",416,""],["bytes=-0",416,""],["bytes=10-",416,""]]){
    const r=await route.GET(new Request("http://offline.invalid",{headers:{range}}),{params:Promise.resolve({id:"meeting"})});assert.equal(r.status,status);assert.equal(await r.text(),text);
  }
});
test("T05 analyze API rejects read-only and unauthenticated users",async()=>{
  const e="src/app/api/meetings/[id]/analyze/route.ts";for(const session of [null,{userId:"demo"}]){
    const m={session,prisma:{user:{findUnique:async()=>({permission:"viewer"})}}};
    const route=await offlineModule(e,m,{"@/lib/db":boundaries["@/lib/db"],"@/lib/auth":"export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>p==='user';",
      "@/lib/meetings/analysis":"export const runMeetingAnalysis=()=>{throw Error('must not call AI')};"});
    assert.equal((await route.POST(new Request("http://offline.invalid"),{params:Promise.resolve({id:"meeting"})})).status,session?403:401);
  }
});
