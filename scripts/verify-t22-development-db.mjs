import assert from "node:assert/strict";
import {zipSync,strToU8} from "fflate";
import {bundleT01Sources,connectDevelopment,newFixture,seedFixture} from "./lib/t01-development.mjs";
import {offlineModule} from "../tests/helpers/offline-module.mjs";
const fixture=newFixture(),env=await connectDevelopment(await bundleT01Sources(),fixture),rollback=Error("EXPECTED_ROLLBACK");
let checks=0;const eq=(a,b)=>{assert.equal(a,b);checks++};
const body="顧客: 予算250万円。9月30日までに見積を確認します。";
const boundaries={
 "server-only":"", "@/lib/db":"export const prisma=mocks.prisma;",
 "@/lib/auth":"export const getSession=async()=>({userId:'demo'});export const hasPermission=()=>true;",
 "@/lib/storage":"export class StorageConfigError extends Error{};export const putFile=async()=>{mocks.uploads++;return {url:'/uploads/mock.mp4'}};",
 "@/lib/meetings/processing":"export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBING:'transcribing',TRANSCRIBED:'transcribed',ANALYZING:'analyzing',COMPLETED:'completed',ERROR:'error'};export const scheduleMeetingTranscription=id=>mocks.transcribe(id);",
 "@/lib/feature-flags":"export const isAutoBantFeatureEnabled=()=>true;",
 "@/lib/ai/summarize-bant":"export const scheduleDealBantSummary=async()=>{mocks.bant++};",
 "@/lib/ai/pipeline":"export const runPipeline=async()=>mocks.result;",
};
try{
 await assert.rejects(env.prisma.$transaction(async tx=>{
  await seedFixture(tx,fixture);
  const mocks={uploads:0,bant:0,transcriptions:0,prisma:new Proxy(tx,{get:(target,p)=>p==="user"?{findUnique:async()=>({permission:"user"})}:target[p]})};
  mocks.transcribe=async id=>{mocks.transcriptions++;await tx.meeting.update({where:{id},data:{transcript:body,processingStatus:"transcribed"}})};
  mocks.result={meetingMinutes:{markdown:body,json:{summary:body},usedFallback:true},structured:{},analysis:{issues:[],bant:{budget:"250万円",authority:"未確認",need:"未確認",timeline:"9月30日"}},topSales:{real_intent:"未確認",winning_scenario:"仮説"},strategy:{},nextActions:{next_actions:[{action:"見積を確認"}]},scores:{},improved:false,fallback:true,trace:[]};
  const entry="src/app/api/meetings/route.ts";
  const route=await offlineModule(entry,mocks,boundaries,[entry,"src/lib/meetings/upload-formats.ts","src/lib/meetings/attachment-text.ts"],["zod","next/server","node:crypto","fflate"]);
  const analyze=await offlineModule("src/lib/meetings/analysis.ts",mocks,boundaries);
  for(const [name,content] of [["demo.txt",Buffer.from(body)],["demo.md",Buffer.from(body)],["demo.docx",Buffer.from(zipSync({"word/document.xml":strToU8(`<w:document><w:p><w:t>${body}</w:t></w:p></w:document>`)}))],["demo.mp4",Buffer.from("mock media")]]){
   const form=new FormData();form.set("dealId",fixture.deal);form.set("file",new File([content],name));
   const res=await route.POST(new Request("http://offline.invalid",{method:"POST",body:form}));eq(res.status,name.endsWith("mp4")?202:201);
   const meeting=(await res.json()).meeting;eq(meeting.transcript,body);eq((await analyze.runMeetingAnalysis(meeting.id)).ok,true);
   const row=await tx.meeting.findUnique({where:{id:meeting.id}});eq(row.minutes,body);eq(row.processingStatus,"completed");eq(row.bantBudget,"250万円");
  }
  eq(mocks.transcriptions,1);eq(mocks.uploads,1);eq(mocks.bant,4);eq((await tx.deal.findUnique({where:{id:fixture.deal}})).nextAction,"見積を確認");
  const res=await route.POST(new Request("http://offline.invalid",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dealId:fixture.deal,transcript:" "})}));eq(res.status,400);
  throw rollback;
 },{maxWait:15000,timeout:90000}),e=>e===rollback);
 eq(await env.base.meeting.count({where:{dealId:fixture.deal}}),0);
 console.log(`T22_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_ROLLED_BACK_MEDIA_AND_AI_MOCKED`);
}finally{await env.close()}
