import test from "node:test";
import assert from "node:assert/strict";
import {offlineModule} from "./helpers/offline-module.mjs";
import {bundleT01Sources,loadSource,routeRequest} from "../scripts/lib/t01-development.mjs";
import selection from "../src/lib/meetings/conference-record-selection.ts";
import meetPhase from "../src/lib/meetings/meet-phase.ts";
const {rankConferenceCandidates,chooseConferenceRecord,pickScheduledMeeting,recordOverlapsSchedule}=selection;
const {MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE}=meetPhase;
const entry="src/lib/meetings/meet-ingest.ts";
const selectionFile="src/lib/meetings/conference-record-selection.ts";
class UniqueError extends Error {code="P2002"}
const at=iso=>new Date(iso);
const sameInstant=(a,b)=>(a==null&&b==null)||(a instanceof Date&&b instanceof Date&&a.getTime()===b.getTime());
const transcriptOf=text=>({text,segments:[{text}],transcriptName:`transcripts/${text}`,docUrl:null});
// Prisma-like filters for the mocks: equality, { not } (SQL semantics: a NULL column never matches), { gte } and OR.
const fieldMatches=(value,cond)=>{
 if(cond===null)return value==null;
 if(typeof cond!=="object"||cond instanceof Date)return cond instanceof Date?value instanceof Date&&value.getTime()===cond.getTime():value===cond;
 if("not" in cond&&(cond.not===null?value==null:value==null||value===cond.not))return false;
 if("gte" in cond&&!(value instanceof Date&&value.getTime()>=cond.gte.getTime()))return false;
 if("in" in cond&&!cond.in.includes(value))return false;
 if("lte" in cond&&!(value instanceof Date&&value.getTime()<=cond.lte.getTime()))return false;
 return true;
};
const rowMatches=(row,where)=>Object.entries(where).every(([key,cond])=>key==="OR"?cond.some(w=>rowMatches(row,w)):fieldMatches(row[key],cond));
function setup(){
 const m={UniqueError,deal:{id:"deal",meetUrl:"https://meet.google.com/abc-defg-hij",meetEventId:"events/demo",meetingStartAt:at("2026-09-21T01:00:00Z"),meetingEndAt:at("2026-09-21T02:00:00Z"),meetArtifactStatus:null,meetArtifactError:null,meetArtifactAttempts:0},meetings:[],created:[],analyses:[],fetched:[],fetchedEnds:[],listed:[],stateWheres:[],
 records:[{name:"conferenceRecords/demo",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"}],transcript:{text:"架空の発言",segments:[{text:"架空の発言"}],transcriptName:"transcripts/demo",docUrl:null}};
 const matches=rowMatches;
 m.prisma={deal:{findUnique:async()=>({...m.deal}),update:async({data})=>Object.assign(m.deal,data),
  // Artifact state writes are conditional on the schedule the ingest read (a concurrent reschedule wins),
  // the waiting/give-up split on the stored attempt count (lt / gte), and the give-up on the stored status (not fetched).
  // m.afterUpdate(where,count) runs after each write, to model a concurrent change between two writes.
  updateMany:async({where,data})=>{m.stateWheres.push(where);
   const attempts=where.meetArtifactAttempts;
   const hit=where.id===m.deal.id&&sameInstant(where.meetingStartAt,m.deal.meetingStartAt)&&sameInstant(where.meetingEndAt,m.deal.meetingEndAt)
    &&(!attempts||((attempts.lt===undefined||m.deal.meetArtifactAttempts<attempts.lt)&&(attempts.gte===undefined||m.deal.meetArtifactAttempts>=attempts.gte)))
    &&(where.meetArtifactStatus===undefined||fieldMatches(m.deal.meetArtifactStatus,where.meetArtifactStatus));
   if(hit)for(const [key,value] of Object.entries(data))m.deal[key]=value&&typeof value==="object"&&"increment" in value?(m.deal[key]??0)+value.increment:value;
   const count=hit?1:0;m.afterUpdate?.(where,count);return {count};
  }},meeting:{
 findMany:async({where,orderBy})=>{m.meetingQueries=(m.meetingQueries??0)+1;const rows=m.meetings.filter(row=>matches(row,where));
  const [[key,direction]=[]]=Object.entries(orderBy??{});if(key)rows.sort((a,b)=>(direction==="desc"?-1:1)*(a[key].getTime()-b[key].getTime()));return rows;},
 findFirst:async({where,orderBy})=>{const rows=m.meetings.filter(row=>matches(row,where));
  const [[key,direction]=[]]=Object.entries(orderBy??{});if(key)rows.sort((a,b)=>(direction==="desc"?-1:1)*(a[key].getTime()-b[key].getTime()));return rows[0]??null;},
 create:async({data})=>{if(m.conflict)throw new UniqueError();m.created.push(data);const id=`meeting-${m.created.length}`;m.meetings.push({id,processingStatus:"transcribed",...data});return {id}}}};return m;
}
const boundaries={
 "@prisma/client":"export const Prisma={PrismaClientKnownRequestError:mocks.UniqueError};",
 "@/lib/db":"export const prisma=mocks.prisma;",
 "next/server":"export const after=()=>{throw Error('unexpected after')};",
 // Only the Google API calls are replaced; record selection runs the real pure module (conference-record-selection.ts).
 "@/lib/google/meet-artifacts":"export const resolveMeetSpace=async()=>({name:'spaces/demo'});export const enableAutoArtifacts=async()=>{if(mocks.configFail)throw Error('permission denied');return {spaceName:'spaces/demo'}};export const listConferenceRecords=async space=>{mocks.listed.push(space);return mocks.records.map(r=>({...r}))};export const fetchMeetTranscript=async (name,end)=>{mocks.fetched.push(name);mocks.fetchedEnds.push(end);return typeof mocks.transcript==='function'?mocks.transcript(name):mocks.transcript};",
 "@/lib/meetings/processing":"export const MEETING_PROCESSING_STATUS={TRANSCRIBED:'transcribed',ERROR:'error'};",
 "@/lib/meetings/analysis":"export const runMeetingAnalysis=async id=>mocks.analyses.push(id);",
};
const load=m=>offlineModule(entry,m,boundaries,[entry,"src/lib/meetings/meet-phase.ts",selectionFile,"src/lib/deal-phase.ts","src/lib/yomi-status.ts"]);
const ingestedRow=(name,start,durationSec,extra={})=>({id:`ingested-${name}`,dealId:"deal",sourceType:"meet_auto",processingStatus:"completed",meetConferenceRecordId:`conferenceRecords/${name}`,meetingDate:at(start),durationSec,...extra});
// What PATCH /api/deals/[id] does when the datetime changes: new schedule, artifact fetch state reset.
const reschedule=m=>Object.assign(m.deal,{meetingStartAt:at("2026-09-28T01:00:00Z"),meetingEndAt:at("2026-09-28T02:00:00Z"),meetArtifactStatus:null,meetArtifactError:null,meetArtifactCheckedAt:null,meetArtifactAttempts:0});
// The ingest reads the current time through Date.now(); pin it while one call runs (the sandbox shares the host Date).
async function atTime(iso,fn){const realNow=Date.now;Date.now=()=>Date.parse(iso);try{return await fn()}finally{Date.now=realNow}}
// Mirrors the cron query (src/app/api/cron/meet-artifacts/route.ts): waiting / fetching / never tried, under the attempt limit.
const cronEligible=(lib,deal)=>(deal.meetArtifactStatus==null||["waiting","fetching"].includes(deal.meetArtifactStatus))&&deal.meetArtifactAttempts<lib.MEET_ARTIFACT_MAX_ATTEMPTS;
test("T16 failed configuration never appears configured",async()=>{
 const m=setup();m.configFail=true;const lib=await load(m);assert.equal((await lib.configureDealMeetArtifacts("deal")).ok,false);assert.equal(m.deal.meetArtifactConfigStatus,"failed");
});
test("T16 missing conference/transcript waits without AI",async()=>{
 for(const field of ["records","transcript"]){const m=setup();m[field]=field==="records"?[]:null;const lib=await load(m);assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"waiting");assert.equal(m.analyses.length,0);assert.equal(m.created.length,0);assert.equal(m.deal.meetArtifactStatus,"waiting");}
});
test("T16 transcript import preserves provenance and schedules AI",async()=>{
 const m=setup(),lib=await load(m);assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched");assert.equal(m.created[0].sourceType,"meet_auto");assert.equal(m.created[0].durationSec,3600);assert.equal(m.created[0].transcript,"架空の発言");assert.equal(m.analyses.length,1);
 assert.equal(m.deal.meetArtifactStatus,"fetched");assert.equal(m.deal.meetArtifactAttempts,1);
 // The conference end is passed so a transcript without its own end time can still be timed (2026-09-30).
 assert.deepEqual(m.fetchedEnds,["2026-09-21T02:00:00Z"]);
 // Every artifact state write is guarded by the schedule that was read.
 for(const where of m.stateWheres){assert.equal(where.id,"deal");assert.equal(where.meetingStartAt.toISOString(),"2026-09-21T01:00:00.000Z");assert.equal(where.meetingEndAt.toISOString(),"2026-09-21T02:00:00.000Z");}
});
test("T16 existing completed record is not duplicated; failed analysis can resume",async()=>{
 // "expired": Meet deletes conference records after 30 days, so the ingested meeting's own span is compared instead.
 for(const listing of ["listed","expired"])for(const status of ["completed","error","transcribed"]){const m=setup();if(listing==="expired")m.records=[];m.meetings=[ingestedRow("demo","2026-09-21T01:00:00Z",3600,{id:"existing",processingStatus:status})];const lib=await load(m);
  const result=await lib.ingestDealMeetArtifacts("deal");
  assert.equal(result.meetingId,"existing",listing);assert.match(result.message,/取り込み済み/);assert.equal(m.created.length,0);assert.equal(m.fetched.length,0);assert.deepEqual(m.listed,["spaces/demo"]);assert.equal(m.analyses.length,status==="completed"?0:1);assert.equal(m.deal.meetArtifactStatus,"fetched");}
});
test("T16 uniqueness conflict must not attach another deal's meeting",async()=>{
 const m=setup();m.conflict=true;m.meetings=[ingestedRow("demo","2026-09-21T01:00:00Z",3600,{id:"wrong-meeting",dealId:"other-deal"})];const lib=await load(m);
 const result=await lib.ingestDealMeetArtifacts("deal");assert.equal(result.status,"failed");assert.equal(result.meetingId,undefined);assert.equal(m.analyses.length,0);
});
test("T16 host joining two minutes early is still ingested",async()=>{
 const m=setup();m.records=[{name:"conferenceRecords/early",startTime:"2026-09-21T00:58:00Z",endTime:"2026-09-21T02:00:00Z"}];const lib=await load(m);
 assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched");
 assert.equal(m.created[0].meetConferenceRecordId,"conferenceRecords/early");
 assert.equal(m.created[0].meetingDate.toISOString(),"2026-09-21T00:58:00.000Z");assert.equal(m.created[0].durationSec,62*60);
});
test("T16 two records: only the main meeting is imported and later runs stay idempotent",async()=>{
 const m=setup();m.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:55:00Z",endTime:"2026-09-21T00:57:00Z"},{name:"conferenceRecords/main",startTime:"2026-09-21T01:02:00Z",endTime:"2026-09-21T02:00:00Z"}];
 m.transcript=name=>transcriptOf(name.endsWith("/pre")?"マイクテスト":"本番の発言");
 const lib=await load(m);
 const first=await lib.ingestDealMeetArtifacts("deal");
 assert.equal(first.status,"fetched");assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);assert.deepEqual(m.fetched,["conferenceRecords/main"]);
 m.meetings[0].processingStatus="completed";
 // A second manual fetch, and a cron run after a small datetime correction (PATCH resets the state), both keep the main meeting.
 const second=await lib.ingestDealMeetArtifacts("deal");
 Object.assign(m.deal,{meetingStartAt:at("2026-09-21T01:30:00Z"),meetingEndAt:at("2026-09-21T02:30:00Z"),meetArtifactStatus:null,meetArtifactAttempts:0});
 const third=await lib.ingestDealMeetArtifacts("deal");
 for(const result of [second,third]){assert.equal(result.status,"fetched");assert.equal(result.meetingId,first.meetingId);assert.match(result.message,/取り込み済み/);}
 assert.equal(m.created.length,1);assert.equal(m.fetched.length,1);assert.equal(m.analyses.length,1);assert.equal(m.deal.meetArtifactStatus,"fetched");
});
test("T16 the record covering the schedule is preferred over a newer rejoin fragment",async()=>{
 for(const order of ["as-listed","reversed"]){
  const m=setup();m.records=[{name:"conferenceRecords/main",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},{name:"conferenceRecords/rejoin",startTime:"2026-09-21T02:30:00Z",endTime:"2026-09-21T02:31:00Z"}];
  if(order==="reversed")m.records.reverse();
  m.transcript=name=>transcriptOf(name.endsWith("/rejoin")?"入り直し":"本番の発言");
  const lib=await load(m);assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched",order);
  assert.deepEqual(m.fetched,["conferenceRecords/main"],order);assert.equal(m.created[0].meetConferenceRecordId,"conferenceRecords/main",order);
 }
});
test("T16 a main record whose transcript is still generating waits instead of importing an early fragment",async()=>{
 const m=setup();m.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:55:00Z",endTime:"2026-09-21T00:57:00Z"},{name:"conferenceRecords/main",startTime:"2026-09-21T01:02:00Z",endTime:"2026-09-21T02:00:00Z"}];
 let mainReady=false;
 m.transcript=name=>name.endsWith("/pre")?transcriptOf("マイクテスト"):mainReady?transcriptOf("本番の発言"):null;
 const lib=await load(m);
 const waiting=await lib.ingestDealMeetArtifacts("deal");
 assert.equal(waiting.status,"waiting");assert.match(waiting.message,/文字起こしがまだ生成されていません/);
 assert.deepEqual(m.fetched,["conferenceRecords/main"]);assert.equal(m.created.length,0);assert.equal(m.analyses.length,0);assert.equal(m.deal.meetArtifactStatus,"waiting");
 mainReady=true;
 assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched");
 assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);assert.equal(m.created[0].transcript,"本番の発言");assert.equal(m.analyses.length,1);
});
test("T16 rescheduled deal ignores the previous meeting's records and imports",async()=>{
 const m=setup();m.deal.meetingStartAt=at("2026-09-28T01:00:00Z");m.deal.meetingEndAt=at("2026-09-28T02:00:00Z");
 m.meetings=[ingestedRow("demo","2026-09-21T01:00:00Z",3600)];const lib=await load(m);
 const result=await lib.ingestDealMeetArtifacts("deal");
 assert.equal(result.status,"waiting");assert.equal(result.meetingId,undefined);assert.equal(m.deal.meetArtifactStatus,"waiting");assert.equal(m.created.length,0);
 m.records.push({name:"conferenceRecords/next",startTime:"2026-09-28T00:59:00Z",endTime:"2026-09-28T02:05:00Z"});
 assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched");assert.equal(m.created[0].meetConferenceRecordId,"conferenceRecords/next");
});
test("T16 a reschedule during the ingest keeps the reset state instead of the old schedule's result",async()=>{
 const outcomes={
  fetched:()=>transcriptOf("前回の会議"),
  waiting:()=>null,
  failed:()=>{throw Error("Meet文字起こし本文の取得に失敗しました");},
 };
 for(const [expected,outcome] of Object.entries(outcomes)){
  const m=setup();m.transcript=()=>{reschedule(m);return outcome();};
  const lib=await load(m);const result=await lib.ingestDealMeetArtifacts("deal");
  assert.equal(result.status,expected);
  assert.equal(m.deal.meetArtifactStatus,null,expected);assert.equal(m.deal.meetArtifactError,null,expected);assert.equal(m.deal.meetArtifactAttempts,0,expected);
  assert.equal(m.deal.meetingStartAt.toISOString(),"2026-09-28T01:00:00.000Z");
  if(expected!=="failed")assert.match(result.message,/取得中に商談日時が変更された/);
  // The meeting that really took place is still recorded and analysed; only the deal's fetch state is left alone.
  assert.equal(m.created.length,expected==="fetched"?1:0);assert.equal(m.analyses.length,expected==="fetched"?1:0);
 }
});
test("T16 start-only schedule uses a half-open window instead of accepting every record",async()=>{
 const m=setup();Object.assign(m.deal,{meetingStartAt:at("2026-09-28T01:00:00Z"),meetingEndAt:null});
 m.records=[{name:"conferenceRecords/old",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},{name:"conferenceRecords/next",startTime:"2026-09-28T01:03:00Z",endTime:"2026-09-28T01:50:00Z"}];
 m.meetings=[ingestedRow("older","2026-09-14T01:00:00Z",3600)];
 const lib=await load(m);
 assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched");
 assert.deepEqual(m.fetched,["conferenceRecords/next"]);assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/next"]);
 m.meetings=[ingestedRow("older","2026-09-14T01:00:00Z",3600)];
 const status=await lib.dealMeetStatus("deal");assert.equal(status.latestMeetingId,null);
});
test("T16 status only reflects meet_auto meetings of the current schedule",async()=>{
 const day=86400000,start=new Date(Math.ceil(Date.now()/day)*day+3*day);
 const m=setup();Object.assign(m.deal,{meetingStartAt:start,meetingEndAt:new Date(start.getTime()+3600000)});
 m.meetings=[ingestedRow("old",new Date(start.getTime()-7*day).toISOString(),3600)];
 const lib=await load(m);let status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"scheduled");assert.equal(status.latestMeetingId,null);assert.equal(status.conferenceRecordId,null);
 m.meetings.push(ingestedRow("current",new Date(start.getTime()-2*60000).toISOString(),3600,{processingStatus:"analyzing"}),{...ingestedRow("upload",start.toISOString(),60,{processingStatus:"completed"}),sourceType:"upload"});
 status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"analyzing");assert.equal(status.latestMeetingId,"ingested-current");assert.equal(status.conferenceRecordId,"conferenceRecords/current");
});
test("T16 status keeps the main meeting when a fragment of the same schedule was created later",async()=>{
 const m=setup();
 // Created in this order: main first, then a later-created mic-test fragment and a rejoin fragment.
 m.meetings=[ingestedRow("main","2026-09-21T01:02:00Z",58*60),ingestedRow("pre","2026-09-21T00:55:00Z",120,{processingStatus:"analyzing"}),ingestedRow("rejoin","2026-09-21T02:30:00Z",60,{processingStatus:"error"})];
 const lib=await load(m);const status=await lib.dealMeetStatus("deal");
 assert.equal(status.latestMeetingId,"ingested-main");assert.equal(status.conferenceRecordId,"conferenceRecords/main");assert.equal(status.phase,"completed");
});
test("T16 a main meeting still running after the scheduled end waits instead of importing the early fragment",async()=>{
 const m=setup();
 m.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:55:00Z",endTime:"2026-09-21T00:57:00Z"},{name:"conferenceRecords/main",startTime:"2026-09-21T01:02:00Z",endTime:null}];
 m.transcript=name=>transcriptOf(name.endsWith("/pre")?"マイクテスト":"本番の発言");
 const lib=await load(m);
 // The cron runs once meetingEndAt has passed, while the main meeting runs over.
 const waiting=await lib.ingestDealMeetArtifacts("deal",{trigger:"cron"});
 assert.equal(waiting.status,"waiting");assert.match(waiting.message,/進行中/);
 assert.deepEqual(m.fetched,[]);assert.equal(m.created.length,0);assert.equal(m.analyses.length,0);assert.equal(m.deal.meetArtifactStatus,"waiting");
 m.records[1].endTime="2026-09-21T02:20:00Z";
 const imported=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(imported.status,"fetched");assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);assert.equal(m.created[0].transcript,"本番の発言");
 m.meetings[0].processingStatus="completed";
 const again=await lib.ingestDealMeetArtifacts("deal");
 assert.equal(again.meetingId,imported.meetingId);assert.match(again.message,/取り込み済み/);
 assert.equal(m.created.length,1);assert.deepEqual(m.fetched,["conferenceRecords/main"]);assert.equal(m.analyses.length,1);
 const status=await lib.dealMeetStatus("deal");assert.equal(status.conferenceRecordId,"conferenceRecords/main");assert.equal(status.phase,"completed");
});
test("T16 a manual fetch during the meeting does not import an earlier segment that fits the schedule less well",async()=>{
 const m=setup();
 m.records=[{name:"conferenceRecords/a",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T01:10:00Z"},{name:"conferenceRecords/b",startTime:"2026-09-21T01:11:00Z",endTime:null}];
 m.transcript=name=>transcriptOf(name.endsWith("/a")?"途中で切れた前半":"本番の発言");
 const lib=await load(m);
 const during=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(during.status,"waiting");assert.match(during.message,/進行中/);assert.deepEqual(m.fetched,[]);assert.equal(m.created.length,0);
 m.records[1].endTime="2026-09-21T02:00:00Z";
 const after=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(after.status,"fetched");assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/b"]);
 const again=await lib.ingestDealMeetArtifacts("deal");
 assert.equal(again.meetingId,after.meetingId);assert.match(again.message,/取り込み済み/);assert.equal(m.created.length,1);assert.deepEqual(m.fetched,["conferenceRecords/b"]);
});
test("T16 a rejoin still in progress after the main meeting ended does not block importing the main meeting",async()=>{
 const m=setup();
 m.records=[{name:"conferenceRecords/main",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},{name:"conferenceRecords/rejoin",startTime:"2026-09-21T02:30:00Z",endTime:null}];
 m.transcript=()=>transcriptOf("本番の発言");
 const lib=await load(m);
 assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched");assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);
 m.meetings[0].processingStatus="completed";
 const again=await lib.ingestDealMeetArtifacts("deal");assert.equal(again.status,"fetched");assert.match(again.message,/取り込み済み/);assert.equal(m.created.length,1);
});
test("T16 an already-ingested fragment is not treated as final when the main meeting fits the schedule better",async()=>{
 const m=setup();
 // The fragment was imported earlier (e.g. by a run while the main meeting was still going); the main meeting has now ended.
 m.meetings=[ingestedRow("pre","2026-09-21T00:55:00Z",120,{processingStatus:"completed"})];
 m.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:55:00Z",endTime:"2026-09-21T00:57:00Z"},{name:"conferenceRecords/main",startTime:"2026-09-21T01:02:00Z",endTime:"2026-09-21T02:20:00Z"}];
 m.transcript=name=>transcriptOf(name.endsWith("/pre")?"マイクテスト":"本番の発言");
 const lib=await load(m);
 const imported=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(imported.status,"fetched");assert.doesNotMatch(imported.message,/取り込み済み/);
 assert.deepEqual(m.fetched,["conferenceRecords/main"]);assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);assert.equal(m.analyses.length,1);
 let status=await lib.dealMeetStatus("deal");assert.equal(status.conferenceRecordId,"conferenceRecords/main");
 m.meetings[1].processingStatus="completed";
 const again=await lib.ingestDealMeetArtifacts("deal");assert.equal(again.meetingId,imported.meetingId);assert.match(again.message,/取り込み済み/);assert.equal(m.created.length,1);
 status=await lib.dealMeetStatus("deal");assert.equal(status.phase,"completed");
});
test("T16 a same-day follow-up on the same Meet link is imported after a meeting that ran over",async()=>{
 for(const follow of [
  // Rescheduled after a gap: the earlier meeting only spills into the new wide window.
  {start:"2026-09-21T03:00:00Z",end:"2026-09-21T04:00:00Z",record:{startTime:"2026-09-21T03:01:00Z",endTime:"2026-09-21T04:00:00Z"},spillsOnly:true},
  // Back to back: the earlier meeting even overlaps the new schedule by 10 minutes, but the follow-up fits it better.
  {start:"2026-09-21T02:00:00Z",end:"2026-09-21T03:00:00Z",record:{startTime:"2026-09-21T02:15:00Z",endTime:"2026-09-21T03:00:00Z"},spillsOnly:false},
 ]){
  const m=setup();
  m.records=[{name:"conferenceRecords/first",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:10:00Z"}];
  m.transcript=name=>transcriptOf(name.endsWith("/first")?"初回の発言":"次回の発言");
  const lib=await load(m);
  assert.equal((await lib.ingestDealMeetArtifacts("deal")).status,"fetched",follow.start);
  m.meetings[0].processingStatus="completed";
  // PATCH /api/deals/[id]: same Meet link, new time later the same day, fetch state reset.
  Object.assign(m.deal,{meetingStartAt:at(follow.start),meetingEndAt:at(follow.end),meetArtifactStatus:null,meetArtifactError:null,meetArtifactAttempts:0});
  if(follow.spillsOnly){
   // Before the follow-up takes place, the earlier meeting is neither shown as the current one nor reported as imported.
   assert.equal((await lib.dealMeetStatus("deal")).latestMeetingId,null);
   const before=await lib.ingestDealMeetArtifacts("deal");
   assert.equal(before.status,"waiting");assert.doesNotMatch(before.message,/取り込み済み/);assert.equal(m.deal.meetArtifactStatus,"waiting");
  }
  m.records.push({name:"conferenceRecords/followup",...follow.record});
  const followup=await lib.ingestDealMeetArtifacts("deal",{trigger:"cron"});
  assert.equal(followup.status,"fetched",follow.start);assert.doesNotMatch(followup.message,/取り込み済み/);
  assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/first","conferenceRecords/followup"],follow.start);assert.equal(m.created[1].transcript,"次回の発言");
  const status=await lib.dealMeetStatus("deal");assert.equal(status.conferenceRecordId,"conferenceRecords/followup",follow.start);
 }
});
test("T16 a manual fetch after an early mic test but before the meeting starts waits and leaves the deal to the cron",async()=>{
 const m=setup();
 m.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:45:00Z",endTime:"2026-09-21T00:47:00Z"}];
 m.transcript=name=>transcriptOf(name.endsWith("/pre")?"マイクテスト":"本番の発言");
 const lib=await load(m);
 // 00:55, schedule 01:00-02:00: the only record is the finished mic test, and its transcript is ready.
 const early=await atTime("2026-09-21T00:55:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"manual"}));
 assert.equal(early.status,"waiting");assert.match(early.message,/開始前/);assert.doesNotMatch(early.message,/取り込み済み/);
 assert.deepEqual(m.fetched,[]);assert.equal(m.created.length,0);assert.equal(m.analyses.length,0);
 assert.equal(m.deal.meetArtifactStatus,"waiting");assert.ok(cronEligible(lib,m.deal));
 assert.equal((await lib.dealMeetStatus("deal")).latestMeetingId,null);
 // The main meeting runs 01:01-02:00; the cron picks the deal up after the scheduled end and imports only the main meeting.
 m.records.push({name:"conferenceRecords/main",startTime:"2026-09-21T01:01:00Z",endTime:"2026-09-21T02:00:00Z"});
 const cron=await atTime("2026-09-21T02:05:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"cron"}));
 assert.equal(cron.status,"fetched");assert.doesNotMatch(cron.message,/予定終了前/);
 assert.deepEqual(m.fetched,["conferenceRecords/main"]);assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);assert.equal(m.created[0].transcript,"本番の発言");
 assert.equal(m.deal.meetArtifactStatus,"fetched");
 assert.equal((await lib.dealMeetStatus("deal")).conferenceRecordId,"conferenceRecords/main");
});
test("T16 a back-to-back reschedule checked before the follow-up stays waiting so the cron imports the follow-up",async()=>{
 const m=setup();
 m.records=[{name:"conferenceRecords/first",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:10:00Z"}];
 m.transcript=name=>transcriptOf(name.endsWith("/first")?"初回の発言":"次回の発言");
 const lib=await load(m);
 // The first meeting (01:00-02:00, ran over to 02:10) is imported after its scheduled end.
 assert.equal((await atTime("2026-09-21T02:11:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"cron"}))).status,"fetched");
 assert.equal(m.deal.meetArtifactStatus,"fetched");m.meetings[0].processingStatus="completed";
 // PATCH /api/deals/[id]: same Meet link, moved to 02:00-03:00, fetch state reset. The first meeting overlaps it by 10 minutes.
 Object.assign(m.deal,{meetingStartAt:at("2026-09-21T02:00:00Z"),meetingEndAt:at("2026-09-21T03:00:00Z"),meetArtifactStatus:null,meetArtifactError:null,meetArtifactAttempts:0});
 const before=await atTime("2026-09-21T02:12:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"manual"}));
 assert.equal(before.status,"fetched");assert.match(before.message,/取り込み済み/);assert.match(before.message,/予定終了前/);
 // Not the terminal "fetched": the cron must still pick the deal up after 03:00.
 assert.equal(m.deal.meetArtifactStatus,"waiting");assert.ok(cronEligible(lib,m.deal));assert.equal(m.created.length,1);
 // The follow-up runs 02:15-03:00; while it is running the deal keeps waiting.
 m.records.push({name:"conferenceRecords/followup",startTime:"2026-09-21T02:15:00Z",endTime:null});
 const during=await atTime("2026-09-21T02:30:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"manual"}));
 assert.equal(during.status,"waiting");assert.match(during.message,/進行中/);assert.ok(cronEligible(lib,m.deal));
 m.records[1].endTime="2026-09-21T03:00:00Z";
 const cron=await atTime("2026-09-21T03:05:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"cron"}));
 assert.equal(cron.status,"fetched");assert.doesNotMatch(cron.message,/取り込み済み/);
 assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/first","conferenceRecords/followup"]);assert.equal(m.created[1].transcript,"次回の発言");
 assert.equal(m.deal.meetArtifactStatus,"fetched");
 assert.equal((await lib.dealMeetStatus("deal")).conferenceRecordId,"conferenceRecords/followup");
});
test("T16 an import before the scheduled end stays waiting: the cron replaces a fragment or settles an early-ended meeting",async()=>{
 // Host is late: at 01:05 only the 00:45-00:47 mic test has ended. It does not touch the schedule, so it is held until the end.
 const late=setup();
 late.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:45:00Z",endTime:"2026-09-21T00:47:00Z"}];
 late.transcript=name=>transcriptOf(name.endsWith("/pre")?"マイクテスト":"本番の発言");
 let lib=await load(late);
 const fragment=await atTime("2026-09-21T01:05:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"manual"}));
 assert.equal(fragment.status,"waiting");assert.match(fragment.message,/予定の終了まで取り込みを保留/);
 assert.equal(late.created.length,0);assert.equal(late.analyses.length,0);
 assert.equal(late.deal.meetArtifactStatus,"waiting");assert.ok(cronEligible(lib,late.deal));
 late.records.push({name:"conferenceRecords/main",startTime:"2026-09-21T01:10:00Z",endTime:"2026-09-21T02:00:00Z"});
 assert.equal((await atTime("2026-09-21T02:05:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"cron"}))).status,"fetched");
 assert.deepEqual(late.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/main"]);
 assert.equal(late.deal.meetArtifactStatus,"fetched");assert.equal((await lib.dealMeetStatus("deal")).conferenceRecordId,"conferenceRecords/main");
 // The meeting ends early (01:00-01:40): imported at 01:45 as waiting, then the cron after 02:00 settles it without a duplicate.
 const early=setup();
 early.records=[{name:"conferenceRecords/main",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T01:40:00Z"}];
 lib=await load(early);
 const imported=await atTime("2026-09-21T01:45:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"manual"}));
 assert.equal(imported.status,"fetched");assert.equal(early.deal.meetArtifactStatus,"waiting");assert.equal(early.analyses.length,1);
 // The panel shows the imported meeting as fetched (not "waiting for artifacts") while the cron re-check is pending.
 assert.equal((await lib.dealMeetStatus("deal")).artifactStatus,"fetched");
 early.meetings[0].processingStatus="completed";
 const settled=await atTime("2026-09-21T02:05:00Z",()=>lib.ingestDealMeetArtifacts("deal",{trigger:"cron"}));
 assert.equal(settled.status,"fetched");assert.equal(settled.meetingId,imported.meetingId);assert.match(settled.message,/取り込み済み/);assert.doesNotMatch(settled.message,/予定終了前/);
 assert.equal(early.deal.meetArtifactStatus,"fetched");assert.equal(early.created.length,1);assert.equal(early.analyses.length,1);assert.deepEqual(early.fetched,["conferenceRecords/main"]);
});
test("T16 without a schedule the newest record decides: new ones are imported, an ingested newest one is idempotent",async()=>{
 const m=setup();Object.assign(m.deal,{meetingStartAt:null,meetingEndAt:null});
 m.meetings=[ingestedRow("a","2026-09-14T01:00:00Z",3600)];
 m.records=[
  {name:"conferenceRecords/older-unimported",startTime:"2026-09-07T01:00:00Z",endTime:"2026-09-07T02:00:00Z"},
  {name:"conferenceRecords/a",startTime:"2026-09-14T01:00:00Z",endTime:"2026-09-14T02:00:00Z"},
  {name:"conferenceRecords/b",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},
 ];
 m.transcript=name=>transcriptOf(name.split("/")[1]);
 const lib=await load(m);
 // A newer meeting than the ingested one is imported instead of a false "already imported".
 const imported=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(imported.status,"fetched");assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/b"]);assert.match(imported.message,/商談日時が未設定/);
 // The newest meeting is now ingested: idempotent, with a message that says which meeting was checked. Older records are not back-filled.
 const again=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(again.status,"fetched");assert.equal(again.meetingId,imported.meetingId);assert.match(again.message,/取り込み済み/);assert.match(again.message,/最新の会議/);
 assert.equal(m.created.length,1);assert.deepEqual(m.fetched,["conferenceRecords/b"]);
 // The newest meeting is still running: wait rather than report the previous one as the result.
 m.records.push({name:"conferenceRecords/c",startTime:"2026-09-28T01:00:00Z",endTime:null});
 const running=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(running.status,"waiting");assert.match(running.message,/進行中/);assert.equal(m.created.length,1);
 m.records[3].endTime="2026-09-28T02:00:00Z";
 assert.equal((await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"})).status,"fetched");
 assert.deepEqual(m.created.map(c=>c.meetConferenceRecordId),["conferenceRecords/b","conferenceRecords/c"]);
});
test("T16 record selection: schedule membership boundaries and schedule-fit order",()=>{
 const start=at("2026-09-21T01:00:00Z"),end=at("2026-09-21T02:00:00Z");
 const records=[
  {name:"conferenceRecords/spills-into-window",startTime:"2026-09-20T23:30:00Z",endTime:"2026-09-21T00:30:00Z"},
  {name:"conferenceRecords/ends-before-window",startTime:"2026-09-20T23:30:00Z",endTime:"2026-09-20T23:59:59Z"},
  {name:"conferenceRecords/starts-at-window-start",startTime:"2026-09-21T00:00:00Z",endTime:"2026-09-21T00:05:00Z"},
  {name:"conferenceRecords/early-into-schedule",startTime:"2026-09-20T23:30:00Z",endTime:"2026-09-21T01:10:00Z"},
  {name:"conferenceRecords/starts-at-window-end",startTime:"2026-09-21T05:00:00Z",endTime:"2026-09-21T05:10:00Z"},
  {name:"conferenceRecords/starts-after-window",startTime:"2026-09-21T05:00:01Z",endTime:"2026-09-21T05:10:00Z"},
  {name:null,startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},
  {name:"conferenceRecords/b-tie",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},
  {name:"conferenceRecords/a-tie",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},
  {name:"conferenceRecords/a-tie",startTime:"2026-09-21T01:00:00Z",endTime:"2026-09-21T02:00:00Z"},
  {name:"conferenceRecords/no-start",endTime:"2026-09-21T01:30:00Z"},
  {name:"conferenceRecords/in-progress-no-start",startTime:null,endTime:null},
 ];
 const short=name=>name.replace("conferenceRecords/","");
 const label=c=>c.kind==="ingested"?`ingested:${short(c.meeting.meetConferenceRecordId)}`:`${c.kind==="in_progress"?"in-progress:":""}${short(c.record.name)}`;
 const order=(list,opts)=>rankConferenceCandidates(list,opts).map(label);
 // Full overlap with the schedule first (name order on ties), then partial overlap, then the longer part of the window, then newest.
 // A record that started before the window and only spills into it without touching the schedule is excluded.
 const scheduledOrder=["a-tie","b-tie","early-into-schedule","starts-at-window-start","starts-at-window-end","no-start"];
 assert.deepEqual(order(records,{start,end}),scheduledOrder);
 assert.deepEqual(order([...records].reverse(),{start,end}),scheduledOrder);
 // Longer overlap with the schedule beats a newer short record; outside the schedule the longer part of the window wins.
 assert.deepEqual(order([
  {name:"conferenceRecords/rejoin",startTime:"2026-09-21T02:30:00Z",endTime:"2026-09-21T02:31:00Z"},
  {name:"conferenceRecords/late-main",startTime:"2026-09-21T02:05:00Z",endTime:"2026-09-21T02:25:00Z"},
  {name:"conferenceRecords/main",startTime:"2026-09-21T01:10:00Z",endTime:"2026-09-21T01:50:00Z"},
  {name:"conferenceRecords/pre",startTime:"2026-09-21T00:55:00Z",endTime:"2026-09-21T01:05:00Z"},
 ],{start,end}),["main","pre","late-main","rejoin"]);
 // Without a schedule every ended record is a candidate, newest first.
 assert.deepEqual(order(records,{}),["starts-after-window","starts-at-window-end","no-start","a-tie","b-tie","starts-at-window-start","early-into-schedule","spills-into-window","ends-before-window"]);
 // Start only: half-open window [start-60min, ∞) instead of no filter.
 assert.deepEqual(order(records,{start,end:null}),["a-tie","b-tie","early-into-schedule","starts-at-window-end","starts-after-window","starts-at-window-start","no-start"]);
 assert.deepEqual(chooseConferenceRecord([],{start,end}),{kind:"none"});
 // Overlap with the schedule itself (used to refuse a pre-start import): touching counts, a mic test that ended before does not.
 assert.equal(recordOverlapsSchedule({startTime:"2026-09-21T00:45:00Z",endTime:"2026-09-21T00:47:00Z"},start,end),false);
 assert.equal(recordOverlapsSchedule({startTime:"2026-09-21T00:45:00Z",endTime:"2026-09-21T01:00:00Z"},start,end),true);
 assert.equal(recordOverlapsSchedule({startTime:"2026-09-21T00:59:00Z",endTime:null},start,end),true);
 assert.equal(recordOverlapsSchedule({endTime:"2026-09-21T01:30:00Z"},start,end),true);
 assert.equal(recordOverlapsSchedule({startTime:"2026-09-21T02:30:00Z",endTime:"2026-09-21T02:40:00Z"},start,null),true);
 assert.equal(recordOverlapsSchedule({startTime:"2026-09-21T00:45:00Z",endTime:"2026-09-21T00:47:00Z"},null,null),true);
});
test("T16 record selection: ingested meetings and in-progress records compete with ended records",()=>{
 const start=at("2026-09-21T01:00:00Z"),end=at("2026-09-21T02:00:00Z");
 const short=name=>name.replace("conferenceRecords/","");
 const label=c=>c.kind==="ingested"?`ingested:${short(c.meeting.meetConferenceRecordId)}`:`${c.kind==="in_progress"?"in-progress:":""}${short(c.record.name)}`;
 const rec=(name,startTime,endTime)=>({name:`conferenceRecords/${name}`,startTime,endTime});
 const row=(name,meetingDate,durationSec)=>({id:`m-${name}`,meetConferenceRecordId:`conferenceRecords/${name}`,meetingDate:at(meetingDate),durationSec});
 const records=[rec("a-tie","2026-09-21T01:00:00Z","2026-09-21T02:00:00Z"),rec("b-tie","2026-09-21T01:00:00Z","2026-09-21T02:00:00Z"),rec("early-into-schedule","2026-09-20T23:30:00Z","2026-09-21T01:10:00Z"),rec("previous-week","2026-09-14T01:00:00Z","2026-09-14T02:00:00Z")];
 // A listed ingested record is compared by its own span and wins ties (idempotent); an ingested meeting whose record is
 // no longer listed is compared by meetingDate + durationSec; meetings of other schedules are ignored.
 const ingested=[row("a-tie","2026-09-21T01:00:00Z",3600),row("expired","2026-09-21T01:05:00Z",600),row("previous-week","2026-09-14T01:00:00Z",3600),row("older","2026-09-07T01:00:00Z",3600)];
 assert.deepEqual(rankConferenceCandidates(records,{start,end,ingested}).map(label),["ingested:a-tie","b-tie","early-into-schedule","ingested:expired"]);
 const decided=chooseConferenceRecord(records,{start,end,ingested});assert.equal(decided.kind,"ingested");assert.equal(decided.meeting.id,"m-a-tie");
 // A better-fitting ended record beats an ingested fragment.
 assert.deepEqual(chooseConferenceRecord([rec("pre","2026-09-21T00:55:00Z","2026-09-21T00:57:00Z"),rec("main","2026-09-21T01:02:00Z","2026-09-21T02:20:00Z")],{start,end,ingested:[row("pre","2026-09-21T00:55:00Z",120)]}),{kind:"import",record:rec("main","2026-09-21T01:02:00Z","2026-09-21T02:20:00Z")});
 // An in-progress record is ranked as if it could run on indefinitely: it wins over a fragment it could outrank...
 assert.deepEqual(chooseConferenceRecord([rec("pre","2026-09-21T00:55:00Z","2026-09-21T00:57:00Z"),rec("main","2026-09-21T01:02:00Z",null)],{start,end}),{kind:"in_progress",record:rec("main","2026-09-21T01:02:00Z",null)});
 assert.deepEqual(chooseConferenceRecord([rec("a","2026-09-21T01:00:00Z","2026-09-21T01:10:00Z"),rec("b","2026-09-21T01:11:00Z",null)],{start,end}),{kind:"in_progress",record:rec("b","2026-09-21T01:11:00Z",null)});
 // ...but not over an ended meeting that already covers more of the schedule than it ever could.
 assert.equal(chooseConferenceRecord([rec("main","2026-09-21T01:00:00Z","2026-09-21T02:00:00Z"),rec("rejoin","2026-09-21T02:30:00Z",null)],{start,end}).kind,"import");
 assert.equal(chooseConferenceRecord([rec("main","2026-09-21T01:00:00Z","2026-09-21T02:00:00Z"),rec("rejoin","2026-09-21T02:30:00Z",null)],{start,end,ingested:[row("main","2026-09-21T01:00:00Z",3600)]}).kind,"ingested");
 // A conference still running since before the window covers the schedule; one that starts after the window is ignored.
 assert.equal(chooseConferenceRecord([rec("long","2026-09-20T20:00:00Z",null)],{start,end}).kind,"in_progress");
 assert.deepEqual(chooseConferenceRecord([rec("later","2026-09-21T05:30:00Z",null)],{start,end}),{kind:"none"});
 // Without a schedule the newest record decides: ingested -> idempotent, running -> wait, otherwise import it.
 const weekly=[rec("w1","2026-09-07T01:00:00Z","2026-09-07T02:00:00Z"),rec("w2","2026-09-14T01:00:00Z","2026-09-14T02:00:00Z")];
 assert.equal(chooseConferenceRecord(weekly,{ingested:[row("w2","2026-09-14T01:00:00Z",3600)]}).kind,"ingested");
 assert.deepEqual(chooseConferenceRecord(weekly,{ingested:[row("w1","2026-09-07T01:00:00Z",3600)]}),{kind:"import",record:weekly[1]});
 assert.equal(chooseConferenceRecord([...weekly,rec("w3","2026-09-21T01:00:00Z",null)],{ingested:[row("w2","2026-09-14T01:00:00Z",3600)]}).kind,"in_progress");
});
test("T16 pickScheduledMeeting uses the same membership and order as record selection",()=>{
 const start=at("2026-09-21T01:00:00Z"),end=at("2026-09-21T02:00:00Z");
 const rows=[{id:"old",meetingDate:at("2026-09-14T01:00:00Z"),durationSec:3600},{id:"pre",meetingDate:at("2026-09-21T00:55:00Z"),durationSec:120},{id:"main",meetingDate:at("2026-09-21T01:02:00Z"),durationSec:3480}];
 assert.equal(pickScheduledMeeting(rows,start,end).id,"main");
 assert.equal(pickScheduledMeeting(rows.slice(0,1),start,end),null);
 assert.equal(pickScheduledMeeting(rows,null,null).id,"main");
 assert.equal(pickScheduledMeeting(rows,start,null).id,"main");
 // A previous same-day meeting that ran over into the rescheduled window is not the new schedule's meeting.
 const first=[{id:"first",meetingDate:at("2026-09-21T01:00:00Z"),durationSec:70*60}];
 assert.equal(pickScheduledMeeting(first,at("2026-09-21T03:00:00Z"),at("2026-09-21T04:00:00Z")),null);
 assert.equal(pickScheduledMeeting(first,at("2026-09-21T02:00:00Z"),at("2026-09-21T03:00:00Z")).id,"first");
});
test("T16 rescheduling an own Meet deal resets artifact fetch state; unchanged times keep it",async()=>{
 const compiled=await bundleT01Sources();
 // The PATCH route bundle is restricted to date/BANT helpers: it cannot reach Google Meet issuance.
 assert.doesNotMatch(compiled.route,/upsertMeetEvent|googleapis|calendar\.events/);
 const artifactState={meetArtifactStatus:"fetched",meetArtifactError:"前回のエラー",meetArtifactCheckedAt:at("2026-09-21T03:00:00Z"),meetArtifactAttempts:7,meetArtifactConfigStatus:"configured"};
 const state={deal:{id:"demo",meetingOwnerType:"own_meet",meetingStartAt:at("2026-09-21T01:00:00Z"),meetingEndAt:at("2026-09-21T02:00:00Z"),meetingScheduledAt:null,updatedAt:at("2026-01-01T00:00:00Z"),deletedAt:null,company:{deletedAt:null},...artifactState},updates:[]};
 const route=loadSource(compiled,"route",{permission:"user",generated:{DealStatus:{LEAD:"LEAD"}},prisma:{deal:{findUnique:async()=>structuredClone(state.deal),update:async({data})=>{state.updates.push(data);Object.assign(state.deal,Object.fromEntries(Object.entries(data).filter(([,v])=>v!==undefined)));return structuredClone(state.deal)}}}});
 const patch=body=>routeRequest(route,{deal:"demo"},body);
 for(const body of [{meetingStartAt:"2026-09-21T01:00:00Z",meetingEndAt:"2026-09-21T02:00:00.000Z"},{meetingOwnerType:"own_meet"},{nextAction:"架空の次回アクション"}]){
  assert.equal((await patch(body)).status,200,JSON.stringify(body));
  assert.equal("meetArtifactStatus" in state.updates.at(-1),false,JSON.stringify(body));
 }
 assert.equal(state.deal.meetArtifactStatus,"fetched");assert.equal(state.deal.meetArtifactAttempts,7);
 for(const body of [{meetingStartAt:"2026-09-28T01:00:00Z",meetingEndAt:"2026-09-28T02:00:00Z"},{meetingEndAt:"2026-09-28T02:30:00Z"}]){
  Object.assign(state.deal,artifactState);
  assert.equal((await patch(body)).status,200,JSON.stringify(body));
  const data=state.updates.at(-1);
  assert.equal(data.meetArtifactStatus,null);assert.equal(data.meetArtifactError,null);assert.equal(data.meetArtifactCheckedAt,null);assert.equal(data.meetArtifactAttempts,0);
  assert.equal("meetArtifactConfigStatus" in data,false);assert.equal(state.deal.meetArtifactConfigStatus,"configured");
 }
});
// The automatic fetch gives up in two ways: the cron stops picking a deal at MEET_ARTIFACT_MAX_ATTEMPTS, and it never
// looks at deals that ended more than MEET_ARTIFACT_LOOKBACK_DAYS ago. Neither may leave the deal silently "waiting".
const hoursAgo=h=>new Date(Date.now()-h*3600000);
test("T16 an attempt that reaches the limit while still waiting is saved as failed with the reason, for every waiting cause",async()=>{
 const causes={
  none:{arrange:m=>{m.records=[];},reason:/終了済みのMeet会議記録がまだありません/},
  transcript:{arrange:m=>{m.transcript=null;},reason:/文字起こしがまだ生成されていません/},
  in_progress:{arrange:m=>{m.records=[{name:"conferenceRecords/main",startTime:"2026-09-21T01:02:00Z",endTime:null}];},reason:/進行中/},
  // Holding a record outside the schedule until the scheduled end: a manual fetch at 01:05 while only the mic test has ended.
  hold:{arrange:m=>{m.records=[{name:"conferenceRecords/pre",startTime:"2026-09-21T00:45:00Z",endTime:"2026-09-21T00:47:00Z"}];},at:"2026-09-21T01:05:00Z",trigger:"manual",reason:/予定の終了まで取り込みを保留/},
 };
 for(const [cause,{arrange,at:time,trigger="cron",reason}] of Object.entries(causes)){
  const m=setup();arrange(m);const lib=await load(m);
  const attempt=()=>time?atTime(time,()=>lib.ingestDealMeetArtifacts("deal",{trigger})):lib.ingestDealMeetArtifacts("deal",{trigger});
  // Attempt 19 of 20 still waits and stays with the cron.
  m.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS-2;
  const before=await attempt();
  assert.equal(before.status,"waiting",cause);assert.match(before.message,reason,cause);assert.equal(m.deal.meetArtifactStatus,"waiting",cause);assert.ok(cronEligible(lib,m.deal),cause);
  // Attempt 20 is the cron's last: the deal is settled as failed (needs attention) instead of an endless "waiting".
  const last=await attempt();
  assert.equal(last.status,"failed",cause);assert.match(last.message,reason,cause);assert.match(last.message,/自動取得の上限に達しました/,cause);
  assert.equal(m.deal.meetArtifactStatus,"failed",cause);assert.equal(m.deal.meetArtifactAttempts,lib.MEET_ARTIFACT_MAX_ATTEMPTS,cause);
  assert.equal(m.deal.meetArtifactError,lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,cause);
  assert.equal(lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,"自動取得の上限に達しました。Meetの文字起こしが作られていない可能性があります。「成果物を取得」で再試行できます。");
  assert.equal(cronEligible(lib,m.deal),false,cause);assert.equal(m.created.length,0,cause);assert.equal(m.analyses.length,0,cause);
  if(cause==="hold")assert.deepEqual(m.fetched,[],cause);
  const status=await lib.dealMeetStatus("deal");
  assert.equal(status.phase,"needs_attention",cause);assert.equal(status.artifactStatus,"failed",cause);assert.equal(status.artifactError,lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,cause);
 }
});
test("T16 the attempt limit is judged on the stored count, so a concurrent run cannot leave the deal waiting past the limit",async()=>{
 const m=setup();const lib=await load(m);
 // Read at 18 (this run makes 19), but a manual fetch running at the same time also increments: the stored count reaches 20.
 m.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS-2;
 m.transcript=()=>{m.deal.meetArtifactAttempts+=1;return null;};
 const result=await lib.ingestDealMeetArtifacts("deal",{trigger:"cron"});
 assert.equal(m.deal.meetArtifactAttempts,lib.MEET_ARTIFACT_MAX_ATTEMPTS);
 assert.equal(result.status,"failed");assert.equal(m.deal.meetArtifactStatus,"failed");assert.equal(cronEligible(lib,m.deal),false);
});
test("T16 a start-only deal is never picked by the cron, so manual attempts past the limit keep waiting",async()=>{
 const m=setup();Object.assign(m.deal,{meetingEndAt:null});m.transcript=null;const lib=await load(m);
 m.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS+3;
 const result=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(result.status,"waiting");assert.equal(m.deal.meetArtifactStatus,"waiting");assert.equal(m.deal.meetArtifactError,null);
});
test("T16 a manual fetch recovers a deal that hit the attempt limit, without duplicates; a reschedule re-arms the cron",async()=>{
 const m=setup();m.transcript=null;const lib=await load(m);
 m.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS-1;
 assert.equal((await lib.ingestDealMeetArtifacts("deal",{trigger:"cron"})).status,"failed");
 // Still no transcript: the manual retry says so and the deal stays visibly failed (it does not fall back to a silent "waiting").
 const retry=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(retry.status,"failed");assert.match(retry.message,/文字起こしがまだ生成されていません/);assert.match(retry.message,/自動取得の上限に達しました/);
 assert.equal(m.deal.meetArtifactStatus,"failed");assert.equal(m.deal.meetArtifactError,lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE);
 // The transcript appears: the manual fetch imports it, clears the reason and hands it to the AI analysis.
 m.transcript=transcriptOf("遅れて生成された文字起こし");
 const recovered=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(recovered.status,"fetched");assert.deepEqual(m.created.map(c=>c.transcript),["遅れて生成された文字起こし"]);assert.equal(m.analyses.length,1);
 assert.equal(m.deal.meetArtifactStatus,"fetched");assert.equal(m.deal.meetArtifactError,null);
 let status=await lib.dealMeetStatus("deal");assert.equal(status.phase,"analyzing");assert.equal(status.artifactError,null);
 // Pressing it again is idempotent.
 m.meetings[0].processingStatus="completed";
 const again=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(again.meetingId,recovered.meetingId);assert.match(again.message,/取り込み済み/);assert.equal(m.created.length,1);assert.equal(m.analyses.length,1);
 status=await lib.dealMeetStatus("deal");assert.equal(status.phase,"completed");
 // A deal that gave up and is then rescheduled (PATCH resets the count) is waiting for the cron again.
 const other=setup();other.transcript=null;const otherLib=await load(other);
 other.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS-1;
 assert.equal((await otherLib.ingestDealMeetArtifacts("deal",{trigger:"cron"})).status,"failed");
 reschedule(other);other.records=[{name:"conferenceRecords/next",startTime:"2026-09-28T01:00:00Z",endTime:"2026-09-28T02:00:00Z"}];
 const next=await otherLib.ingestDealMeetArtifacts("deal",{trigger:"cron"});
 assert.equal(next.status,"waiting");assert.equal(other.deal.meetArtifactStatus,"waiting");assert.equal(other.deal.meetArtifactAttempts,1);assert.ok(cronEligible(otherLib,other.deal));
});
test("T16 a deal still waiting after the cron's 7-day window shows as needs attention without a database write",async()=>{
 const m=setup();const lib=await load(m);
 for(const artifactStatus of [null,"waiting","fetching"]){
  // Ended 8 days ago: the cron (meetingEndAt >= now - 7 days) no longer picks it.
  Object.assign(m.deal,{meetingStartAt:hoursAgo(8*24+1),meetingEndAt:hoursAgo(8*24),meetArtifactStatus:artifactStatus,meetArtifactAttempts:3});
  m.stateWheres=[];
  const status=await lib.dealMeetStatus("deal");
  assert.equal(status.phase,"needs_attention",String(artifactStatus));assert.equal(status.artifactStatus,"failed",String(artifactStatus));
  assert.match(status.artifactError,/商談終了から7日を過ぎたため、自動取得を終了しました。.*「成果物を取得」で再試行できます。/,String(artifactStatus));
  assert.deepEqual(m.stateWheres,[]);assert.equal(m.deal.meetArtifactStatus,artifactStatus);
  // Within the window the same deal is still an ordinary wait.
  Object.assign(m.deal,{meetingStartAt:hoursAgo(6*24+1),meetingEndAt:hoursAgo(6*24)});
  const inWindow=await lib.dealMeetStatus("deal");
  assert.equal(inWindow.artifactStatus,artifactStatus);assert.equal(inWindow.artifactError,null);
  assert.equal(inWindow.phase,artifactStatus==="fetching"?"fetching":"waiting_artifacts");
 }
 // A stored failure keeps its own reason; an imported meeting is never overridden.
 Object.assign(m.deal,{meetingStartAt:hoursAgo(8*24+1),meetingEndAt:hoursAgo(8*24),meetArtifactStatus:"failed",meetArtifactError:"権限がありません"});
 assert.equal((await lib.dealMeetStatus("deal")).artifactError,"権限がありません");
 Object.assign(m.deal,{meetArtifactStatus:"waiting",meetArtifactError:null});
 m.meetings=[ingestedRow("old",hoursAgo(8*24+1).toISOString(),3600,{processingStatus:"completed"})];
 const imported=await lib.dealMeetStatus("deal");
 assert.equal(imported.phase,"completed");assert.equal(imported.artifactStatus,"fetched");assert.equal(imported.artifactError,null);
});
test("T16 a manual fetch still works after the 7-day window and the status follows the result",async()=>{
 const m=setup();Object.assign(m.deal,{meetingStartAt:hoursAgo(8*24+1),meetingEndAt:hoursAgo(8*24),meetArtifactStatus:"waiting",meetArtifactAttempts:4});
 m.records=[{name:"conferenceRecords/late",startTime:hoursAgo(8*24+1).toISOString(),endTime:hoursAgo(8*24).toISOString()}];
 m.transcript=null;const lib=await load(m);
 // Nothing yet: stored as waiting (under the limit), still shown as needing attention because the cron will not come back.
 assert.equal((await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"})).status,"waiting");
 assert.equal((await lib.dealMeetStatus("deal")).phase,"needs_attention");
 m.transcript=transcriptOf("期間後に取り込んだ発言");
 const imported=await lib.ingestDealMeetArtifacts("deal",{trigger:"manual"});
 assert.equal(imported.status,"fetched");assert.equal(m.created.length,1);assert.equal(m.analyses.length,1);
 const status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"analyzing");assert.equal(status.artifactStatus,"fetched");assert.equal(status.artifactError,null);
});
test("T16 a Meet reissue that resets the attempt count between the two settle writes is not overwritten by the give-up",async()=>{
 const m=setup();m.transcript=null;const lib=await load(m);
 m.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS-1;
 // The waiting write misses (the count reached the limit); before the give-up write, POST /api/deals/[id]/meet reissues
 // the Meet and resets the fetch state and the count (the schedule is unchanged).
 m.afterUpdate=(where,count)=>{
  if(where.meetArtifactAttempts?.lt===undefined||count!==0)return;
  m.afterUpdate=null;
  Object.assign(m.deal,{meetSpaceName:null,meetArtifactStatus:null,meetArtifactError:null,meetArtifactCheckedAt:null,meetArtifactAttempts:0});
 };
 const result=await lib.ingestDealMeetArtifacts("deal",{trigger:"cron"});
 assert.equal(result.status,"waiting");assert.match(result.message,/文字起こしがまだ生成されていません/);assert.match(result.message,/再発行などで取得状態がリセットされた/);
 assert.doesNotMatch(result.message,/自動取得の上限に達しました|商談日時が変更された/);
 // The reset state survives, so the cron picks the reissued Meet up again.
 assert.equal(m.deal.meetArtifactStatus,null);assert.equal(m.deal.meetArtifactError,null);assert.equal(m.deal.meetArtifactAttempts,0);assert.ok(cronEligible(lib,m.deal));
 assert.equal(m.stateWheres.at(-1).meetArtifactAttempts.gte,lib.MEET_ARTIFACT_MAX_ATTEMPTS);
});
test("T16 the give-up never overwrites a fetch that a concurrent run completed",async()=>{
 const m=setup();m.transcript=null;const lib=await load(m);
 m.deal.meetArtifactAttempts=lib.MEET_ARTIFACT_MAX_ATTEMPTS-1;
 // The cron's 20th attempt still finds no transcript; between its two settle writes a manual fetch imports the meeting.
 m.afterUpdate=(where,count)=>{
  if(where.meetArtifactAttempts?.lt===undefined||count!==0)return;
  m.afterUpdate=null;
  m.meetings.push(ingestedRow("demo","2026-09-21T01:00:00Z",3600,{processingStatus:"analyzing"}));
  Object.assign(m.deal,{meetArtifactStatus:"fetched",meetArtifactError:null});
 };
 const result=await lib.ingestDealMeetArtifacts("deal",{trigger:"cron"});
 assert.equal(result.status,"fetched");assert.match(result.message,/同時に実行された取得で、この会議の文字起こしは取り込み済みです/);
 assert.doesNotMatch(result.message,/自動取得の上限に達しました|商談日時が変更された/);
 assert.equal(m.deal.meetArtifactStatus,"fetched");assert.equal(m.deal.meetArtifactError,null);assert.equal(m.created.length,0);
 const status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"analyzing");assert.equal(status.artifactStatus,"fetched");assert.equal(status.artifactError,null);
});
test("T16 an imported meeting of the current schedule is never displayed as a given-up fetch; a real error still is",async()=>{
 const m=setup();const lib=await load(m);
 m.meetings=[ingestedRow("demo","2026-09-21T01:00:00Z",3600,{processingStatus:"completed"})];
 // The stored give-up (a fragment was imported, then the main meeting never produced a transcript, or an older race).
 Object.assign(m.deal,{meetArtifactStatus:"failed",meetArtifactError:lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,meetArtifactAttempts:lib.MEET_ARTIFACT_MAX_ATTEMPTS});
 let status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"completed");assert.equal(status.artifactStatus,"fetched");assert.equal(status.artifactError,null);assert.equal(status.latestMeetingId,"ingested-demo");
 // Derived give-ups (a legacy waiting row at the limit, past the 7-day window) do not override it either.
 Object.assign(m.deal,{meetArtifactStatus:"waiting",meetArtifactError:null});
 status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"completed");assert.equal(status.artifactStatus,"fetched");assert.equal(status.artifactError,null);
 // A real fetch error is not a give-up: it stays visible.
 Object.assign(m.deal,{meetArtifactStatus:"failed",meetArtifactError:"権限がありません"});
 status=await lib.dealMeetStatus("deal");
 assert.equal(status.artifactStatus,"failed");assert.equal(status.artifactError,"権限がありません");
});
test("T16 a row left waiting or fetching at the attempt limit is shown as given up, but a fetch in progress is not",async()=>{
 const m=setup();const lib=await load(m);
 // Ended an hour ago: inside the cron's 7-day window, but the cron skips the deal because of the stored count.
 const base={meetingStartAt:hoursAgo(2),meetingEndAt:hoursAgo(1),meetArtifactError:null,meetArtifactAttempts:lib.MEET_ARTIFACT_MAX_ATTEMPTS};
 // Legacy waiting rows, a 20th attempt that crashed while fetching (with or without a check time), and an untouched row.
 for(const [artifactStatus,checkedAt] of [["waiting",hoursAgo(1)],["fetching",hoursAgo(1)],["fetching",null],[null,null]]){
  const label=`${artifactStatus}@${checkedAt?.toISOString()}`;
  Object.assign(m.deal,base,{meetArtifactStatus:artifactStatus,meetArtifactCheckedAt:checkedAt});
  assert.equal(cronEligible(lib,m.deal),false,label);
  m.stateWheres=[];
  const status=await lib.dealMeetStatus("deal");
  assert.equal(status.phase,"needs_attention",label);assert.equal(status.artifactStatus,"failed",label);assert.equal(status.artifactError,lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,label);
  assert.deepEqual(m.stateWheres,[],label);assert.equal(m.deal.meetArtifactStatus,artifactStatus,label);
 }
 // A fetch that started a minute ago (the cron's 20th attempt or a manual retry) is still running: it stays "fetching" and keeps polling.
 Object.assign(m.deal,{meetArtifactStatus:"fetching",meetArtifactCheckedAt:new Date(Date.now()-60000)});
 const running=await lib.dealMeetStatus("deal");
 assert.equal(running.phase,"fetching");assert.equal(running.artifactStatus,"fetching");assert.equal(running.artifactError,null);
 // Under the limit the cron still picks the deal: an ordinary wait.
 Object.assign(m.deal,{meetArtifactStatus:"waiting",meetArtifactAttempts:lib.MEET_ARTIFACT_MAX_ATTEMPTS-1});
 assert.ok(cronEligible(lib,m.deal));
 const under=await lib.dealMeetStatus("deal");
 assert.equal(under.phase,"waiting_artifacts");assert.equal(under.artifactStatus,"waiting");assert.equal(under.artifactError,null);
});
test("T16 a deal whose Meet was never issued is not reported as a given-up automatic fetch",async()=>{
 const m=setup();const lib=await load(m);
 // The cron only picks deals with a Calendar event (meetEventId), and the panel's fetch button needs the Meet URL.
 const issues=[{meetUrl:null,meetEventId:null},{meetUrl:"",meetEventId:null},{meetUrl:null,meetEventId:"events/pending"},{meetUrl:"https://meet.google.com/abc-defg-hij",meetEventId:null}];
 const states=[
  // Past the 7-day window, never tried.
  {meetingStartAt:hoursAgo(8*24+1),meetingEndAt:hoursAgo(8*24),meetArtifactStatus:null,meetArtifactAttempts:0},
  // A waiting row at the attempt limit.
  {meetingStartAt:hoursAgo(2),meetingEndAt:hoursAgo(1),meetArtifactStatus:"waiting",meetArtifactAttempts:lib.MEET_ARTIFACT_MAX_ATTEMPTS},
 ];
 for(const issue of issues)for(const state of states){
  const label=JSON.stringify({...issue,status:state.meetArtifactStatus});
  Object.assign(m.deal,issue,state,{meetArtifactError:null,meetArtifactCheckedAt:null});
  const status=await lib.dealMeetStatus("deal");
  assert.equal(status.phase,"waiting_artifacts",label);assert.equal(status.artifactStatus,state.meetArtifactStatus,label);assert.equal(status.artifactError,null,label);
 }
 // Once issued, the same deals are given up.
 Object.assign(m.deal,{meetUrl:"https://meet.google.com/abc-defg-hij",meetEventId:"events/demo"},states[0]);
 assert.equal((await lib.dealMeetStatus("deal")).artifactError,MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE);
});
test("T16 a meeting recorded through another route after the scheduled start clears the give-up; other records do not",async()=>{
 const m=setup();const lib=await load(m);
 const start=hoursAgo(8*24+1),end=hoursAgo(8*24);
 const other=extra=>({id:"other",dealId:"deal",sourceType:"upload",processingStatus:"transcribing",recordingUrl:"recordings/demo.webm",transcript:null,minutes:null,meetConferenceRecordId:null,meetingDate:hoursAgo(2),durationSec:null,createdAt:hoursAgo(2),...extra});
 const counted=[
  // Browser recording or a media attachment still being transcribed, and one that finished.
  [other({}),"analyzing"],
  [other({processingStatus:"completed",summary:"AIの要約"}),"completed"],
  // A text attachment (manual_text with the extracted transcript), and hand-written minutes created right at the scheduled start.
  [other({sourceType:"manual_text",recordingUrl:null,transcript:"添付の本文",processingStatus:"transcribed"}),"analyzing"],
  // Hand-written minutes are stored as completed without any AI analysis (no summary): recorded, not "AI分析まで完了" (2026-09-30).
  [other({sourceType:"manual_text",recordingUrl:null,minutes:"手入力の議事録",processingStatus:"completed",createdAt:new Date(start.getTime())}),"recorded"],
  // Once the analysis has been run on it (summary present), it is complete.
  [other({sourceType:"manual_text",recordingUrl:null,minutes:"手入力の議事録",processingStatus:"completed",summary:"AIの要約"}),"completed"],
 ];
 const notCounted=[
  // Created before the scheduled start (a previous meeting's record), even with its meetingDate edited into the schedule.
  other({createdAt:new Date(start.getTime()-1),meetingDate:new Date(start.getTime()+60000)}),
  // Processing failed: the meeting was not captured.
  other({processingStatus:"error"}),
  // An empty draft created to write the minutes later.
  other({sourceType:"manual_text",recordingUrl:null,processingStatus:"completed"}),
  // A Meet import of another schedule is not "another route".
  other({sourceType:"meet_auto",recordingUrl:null,transcript:"前回の会議",processingStatus:"completed",meetConferenceRecordId:"conferenceRecords/old",meetingDate:hoursAgo(30*24),durationSec:3600}),
 ];
 const givenUp=[
  {meetArtifactStatus:"waiting",meetArtifactError:null,meetArtifactAttempts:3,expected:MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE},
  {meetArtifactStatus:"failed",meetArtifactError:lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,meetArtifactAttempts:lib.MEET_ARTIFACT_MAX_ATTEMPTS,expected:lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE},
 ];
 for(const {expected,...stored} of givenUp){
  Object.assign(m.deal,{meetingStartAt:start,meetingEndAt:end,meetArtifactCheckedAt:null},stored);
  for(const [row,phase] of counted){
   m.meetings=[row];
   const status=await lib.dealMeetStatus("deal");
   const label=`${stored.meetArtifactStatus}:${row.sourceType}:${row.processingStatus}`;
   assert.equal(status.phase,phase,label);assert.equal(status.artifactStatus,null,label);assert.equal(status.artifactError,null,label);assert.equal(status.latestMeetingId,null,label);
  }
  for(const row of notCounted){
   m.meetings=[row];
   const status=await lib.dealMeetStatus("deal");
   const label=`${stored.meetArtifactStatus}:${row.sourceType}:${row.processingStatus}:${row.createdAt.toISOString()}`;
   assert.equal(status.phase,"needs_attention",label);assert.equal(status.artifactStatus,"failed",label);assert.equal(status.artifactError,expected,label);
  }
 }
 // Several counted records: the newest one (by creation) decides, so a re-upload still being processed shows as analyzing.
 m.meetings=[other({id:"first",processingStatus:"completed",createdAt:hoursAgo(5)}),other({id:"reupload",processingStatus:"transcribing",createdAt:hoursAgo(1)})];
 assert.equal((await lib.dealMeetStatus("deal")).phase,"analyzing");
 m.meetings.reverse();
 assert.equal((await lib.dealMeetStatus("deal")).phase,"analyzing");
 // A real fetch error is not a give-up: another route's record does not hide it.
 Object.assign(m.deal,{meetArtifactStatus:"failed",meetArtifactError:"権限がありません"});m.meetings=[counted[1][0]];
 let status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"needs_attention");assert.equal(status.artifactError,"権限がありません");
 // While the cron is still trying (inside the window, under the limit), another route's record does not change the wait.
 Object.assign(m.deal,{meetingStartAt:hoursAgo(3),meetingEndAt:hoursAgo(2),meetArtifactStatus:"waiting",meetArtifactError:null,meetArtifactAttempts:3});
 m.meetings=[other({processingStatus:"completed"})];
 status=await lib.dealMeetStatus("deal");
 assert.equal(status.phase,"waiting_artifacts");assert.equal(status.artifactStatus,"waiting");
});
// 商談一覧（T16、2026-09-30 meet-status）：要対応の商談に一覧でも小さな「要対応」を出す。判定は商談ページ上部の要約
// （dealMeetStatus の phase ＋ dealMeetNeedsAttention）と同じ。商談ごとには問い合わせず、必要な件数だけ読む。
// Relation reads the list uses: deal.findMany({ where:{id:{in}}, select:{ id, meetings:{ where, orderBy, take } } }).
function withDealRelationReads(m){
 m.relationReads=[];
 m.prisma.deal.findMany=async({where,select})=>{m.meetingQueries=(m.meetingQueries??0)+1;const rel=select.meetings;m.relationReads.push(rel);
  return where.id.in.map(id=>{let rows=m.meetings.filter(row=>row.dealId===id&&rowMatches(row,rel.where??{}));
   const [[key,direction]=[]]=Object.entries(rel.orderBy??{});if(key)rows.sort((a,b)=>(direction==="desc"?-1:1)*(a[key].getTime()-b[key].getTime()));
   return {id,meetings:rows.slice(0,rel.take??rows.length)};});};
}
test("T16 deals list: 要対応 matches the deal page's hero, deal by deal, with bounded reads",async()=>{
 const m=setup();withDealRelationReads(m);const lib=await load(m);const dealPhaseModule=await import("../src/lib/deal-phase.ts");
 const {deriveDealPhase,dealMeetNeedsAttention}=dealPhaseModule.deriveDealPhase?dealPhaseModule:dealPhaseModule.default;
 const base={status:"PROPOSAL",products:[{yomiStatus:"Bヨミ"}],meetUrl:"https://meet.google.com/abc-defg-hij",meetEventId:"events/demo",meetArtifactConfigStatus:"configured",meetArtifactError:null,meetArtifactCheckedAt:null};
 const ended=days=>({meetingStartAt:hoursAgo(days*24+1),meetingEndAt:hoursAgo(days*24)});
 const exhausted={meetArtifactStatus:"failed",meetArtifactError:lib.MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,meetArtifactAttempts:lib.MEET_ARTIFACT_MAX_ATTEMPTS};
 const deals=[
  // Waiting past the 7-day window: given up.
  {id:"expired",...base,...ended(9),meetArtifactStatus:"waiting",meetArtifactAttempts:3},
  // Stored give-up at the attempt limit.
  {id:"exhausted",...base,...ended(2),...exhausted},
  // A real fetch error.
  {id:"error",...base,...ended(1),meetArtifactStatus:"failed",meetArtifactError:"権限がありません",meetArtifactAttempts:1},
  // Given up, but rescued by a hand-written record after the start.
  {id:"rescued",...base,...ended(9),meetArtifactStatus:"waiting",meetArtifactAttempts:3},
  // Given up, and the only other record predates the schedule (a previous meeting's minutes).
  {id:"old-record",...base,...ended(9),meetArtifactStatus:"waiting",meetArtifactAttempts:3},
  // Given up, but the Meet meeting of this schedule was imported.
  {id:"imported",...base,meetingStartAt:at("2026-09-21T01:00:00Z"),meetingEndAt:at("2026-09-21T02:00:00Z"),...exhausted},
  // Still inside the window and under the limit: the cron is still trying.
  {id:"waiting",...base,...ended(1),meetArtifactStatus:"waiting",meetArtifactAttempts:3},
  // The imported meeting's analysis failed.
  {id:"analysis-error",...base,meetingStartAt:at("2026-09-21T01:00:00Z"),meetingEndAt:at("2026-09-21T02:00:00Z"),meetArtifactStatus:"fetched",meetArtifactAttempts:1},
  // Won and lost deals with the same give-up: the hero shows no 要対応, nor does the list.
  {id:"won",...base,...ended(2),...exhausted,status:"WON"},
  {id:"lost",...base,...ended(2),...exhausted,status:"LOST"},
  // Won only by a product's yomi (Notion imports keep deals.status LEAD): the list puts it in 受注後, so no 要対応 either (2026-10-01 recheck Y1).
  {id:"won-by-yomi",...base,...ended(2),...exhausted,status:"LEAD",products:[{yomiStatus:"Bヨミ"},{yomiStatus:"【映像】受注"}]},
  {id:"won-by-alliance",...base,...ended(2),...exhausted,status:"LEAD",products:[{yomiStatus:"締結済み"}]},
  // Not won: NG / ネタ yomi and no products keep the 要対応.
  {id:"ng-yomi",...base,...ended(2),...exhausted,status:"LEAD",products:[{yomiStatus:"【SNS】NG"},{yomiStatus:"ネタ"}]},
  {id:"no-products",...base,...ended(2),...exhausted,status:"LEAD",products:[]},
  // Rescheduled to a future meeting while a real fetch error of the old one is still stored: 商談前, no 要対応.
  {id:"rescheduled",...base,meetingStartAt:hoursAgo(-48),meetingEndAt:hoursAgo(-47),meetArtifactStatus:"failed",meetArtifactError:"権限がありません",meetArtifactAttempts:1},
  // A future meeting whose earlier recording is still being processed is 終了直後 on the page (processing wins): 要対応 stays consistent.
  {id:"processing",...base,meetingStartAt:hoursAgo(-48),meetingEndAt:hoursAgo(-47),meetArtifactStatus:"failed",meetArtifactError:"権限がありません",meetArtifactAttempts:1},
  // No schedule and no record: 商談前 (planning) on the page.
  {id:"unscheduled",...base,meetingStartAt:null,meetingEndAt:null,meetArtifactStatus:"failed",meetArtifactError:"権限がありません",meetArtifactAttempts:1},
  // No schedule, with an analysis-failed Meet import: 商談後 on the page.
  {id:"unscheduled-error",...base,meetingStartAt:null,meetingEndAt:null,meetArtifactStatus:"fetched",meetArtifactAttempts:1},
 ];
 const startOf=id=>deals.find(d=>d.id===id).meetingStartAt;
 const row=(id,dealId,extra)=>({id,dealId,sourceType:"manual_text",processingStatus:"completed",recordingUrl:null,transcript:null,minutes:"議事録",summary:null,meetConferenceRecordId:null,durationSec:null,...extra});
 m.meetings=[
  row("manual","rescued",{createdAt:new Date(startOf("rescued").getTime()+3600000),meetingDate:startOf("rescued")}),
  row("previous","old-record",{createdAt:new Date(startOf("old-record").getTime()-1),meetingDate:startOf("old-record")}),
  ingestedRow("imported","2026-09-21T01:00:00Z",3600,{dealId:"imported",processingStatus:"completed",createdAt:at("2026-09-21T03:00:00Z")}),
  ingestedRow("analysis-error","2026-09-21T01:00:00Z",3600,{dealId:"analysis-error",processingStatus:"error",createdAt:at("2026-09-21T03:00:00Z")}),
  // Older Meet imports of analysis-error's previous schedules, outside the current schedule's window: never read.
  ...[1,2,3].map(n=>ingestedRow(`old-${n}`,`2026-08-0${n}T01:00:00Z`,3600,{dealId:"analysis-error",processingStatus:"completed",createdAt:at(`2026-08-0${n}T03:00:00Z`)})),
  row("upload","processing",{sourceType:"upload",processingStatus:"transcribing",recordingUrl:"r.webm",minutes:null,createdAt:hoursAgo(1),meetingDate:hoursAgo(2)}),
  ingestedRow("unscheduled-error","2026-09-21T01:00:00Z",3600,{dealId:"unscheduled-error",processingStatus:"error",createdAt:at("2026-09-21T03:00:00Z")}),
 ];
 const reads=[];const findMany=m.prisma.meeting.findMany;m.prisma.meeting.findMany=async args=>{const rows=await findMany(args);reads.push(...rows);return rows;};
 m.meetingQueries=0;
 const ids=await lib.dealIdsNeedingMeetAttention(deals);
 assert.deepEqual([...ids].sort(),["analysis-error","error","exhausted","expired","ng-yomi","no-products","old-record","processing","unscheduled-error"]);
 // At most 4 queries whatever the number of rows; every relation read takes one row per deal.
 assert.ok(m.meetingQueries<=4,`queries: ${m.meetingQueries}`);
 for(const rel of m.relationReads)assert.equal(rel.take,1);
 assert.ok(!reads.some(r=>r.id.startsWith("old-")),"meet_auto rows of previous schedules were read");
 // Same verdict as the deal page's hero, deal by deal (page.tsx: deriveDealPhase over all meetings + dealMeetNeedsAttention).
 m.prisma.meeting.findMany=findMany;
 for(const deal of deals){
  m.deal={...deal};
  const meetings=m.meetings.filter(r=>r.dealId===deal.id).sort((a,b)=>b.meetingDate-a.meetingDate);
  const phase=deriveDealPhase({meetingStartAt:deal.meetingStartAt,meetingEndAt:deal.meetingEndAt,meetUrl:deal.meetUrl,meetingsCount:meetings.length,
   latestMeetingStatus:meetings[0]?.processingStatus??null,latestMeetingHasMinutes:Boolean(meetings[0]?.minutes)});
  const hero=dealMeetNeedsAttention(phase,(await lib.dealMeetStatus(deal.id)).phase,deal);
  assert.equal(ids.has(deal.id),hero,deal.id);
 }
 // Nothing to check (no deals, or only closed ones): no query at all.
 m.meetingQueries=0;
 assert.equal((await lib.dealIdsNeedingMeetAttention([])).size,0);
 assert.equal((await lib.dealIdsNeedingMeetAttention(deals.filter(d=>["won","lost","won-by-yomi","won-by-alliance"].includes(d.id)))).size,0);
 assert.equal(m.meetingQueries,0);
});
