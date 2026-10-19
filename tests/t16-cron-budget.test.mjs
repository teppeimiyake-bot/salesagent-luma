import assert from "node:assert/strict";
import test from "node:test";
import {offlineModule} from "./helpers/offline-module.mjs";
import phase from "../src/lib/meetings/meet-phase.ts";
const entry="src/app/api/cron/meet-artifacts/route.ts";
// Each import advances a simulated clock; the host clock is replaced only while a request runs.
async function setup(minutesPerDeal){
 const mocks={valid:true,enabled:true,tenant:null,clock:0,queries:[],calls:[]};
 mocks.prisma={deal:{findMany:async query=>{
  mocks.queries.push({tenant:mocks.tenant,...query});
  if(query.where.meetArtifactStatus===null)return [];
  return Array.from({length:Math.min(query.take,mocks.tenant==="a"?2:5)},(_,i)=>({id:`${mocks.tenant}-${i}`}));
 }}};
 const route=await offlineModule(entry,mocks,{
  "@/lib/db":"export const prisma=mocks.prisma;export const prismaUnscoped={tenant:{findMany:async()=>[{code:'a'},{code:'b'},{code:'c'}]}};",
  "@/lib/agent-auth":"export const isValidCronSecret=()=>mocks.valid;",
  "@/lib/feature-flags":"export const isMeetAutoRecordEnabled=()=>mocks.enabled;",
  "@/lib/tenant-context":"export const runAsTenant=async(code,fn)=>{mocks.tenant=code;return fn()};",
  "@/lib/meetings/meet-ingest":`export const MEET_ARTIFACT_MAX_ATTEMPTS=12;export const ingestDealMeetArtifacts=async(id)=>{mocks.calls.push({id,at:mocks.clock});mocks.clock+=${minutesPerDeal}*60000;return {status:'fetched',message:'mock'}};`,
 });
 const run=async()=>{const realNow=Date.now;Date.now=()=>mocks.clock;
  try{const res=await route.GET(new Request("http://offline.invalid"));return{status:res.status,body:await res.json()}}finally{Date.now=realNow}};
 return{run,mocks};
}
test("T16 cron stops starting new deals after the 150 second budget and reports the skipped count and exhaustion",async()=>{
 const{run,mocks}=await setup(1);
 const{status,body}=await run();
 assert.equal(status,200);
 // a-0@0s a-1@60s b-0@120s; b-1/b-2 would start at >=180s and are left for the next run.
 assert.deepEqual(mocks.calls.map(c=>c.id),["a-0","a-1","b-0"]);
 assert.ok(mocks.calls.every(c=>c.at<150000));
 assert.equal(body.processed,3);assert.equal(body.fetched,3);assert.equal(body.timeBudgetSkipped,2);
 // The count is a lower bound (tenant c is never queried), so the response also says the budget stopped the run.
 assert.equal(body.timeBudgetExhausted,true);
 assert.equal(body.skipped,false);
 // Tenant c is not queried once the budget is spent.
 assert.equal(mocks.queries.some(q=>q.tenant==="c"),false);
});
test("T16 cron within budget keeps the five-deal limit and reports no skipped deals",async()=>{
 const{run,mocks}=await setup(0.1);
 const{body}=await run();
 assert.deepEqual(mocks.calls.map(c=>c.id),["a-0","a-1","b-0","b-1","b-2"]);
 assert.equal(body.processed,5);assert.equal(body.timeBudgetSkipped,0);assert.equal(body.timeBudgetExhausted,false);
});
test("T16 cron budget keeps the cron secret and feature flag checks first",async()=>{
 const unauthorized=await setup(1);unauthorized.mocks.valid=false;
 assert.equal((await unauthorized.run()).status,401);
 const disabled=await setup(1);disabled.mocks.enabled=false;
 assert.equal((await disabled.run()).body.skipped,true);
 for(const{mocks}of[unauthorized,disabled]){assert.equal(mocks.calls.length,0);assert.equal(mocks.queries.length,0);}
});
test("T16 cron reports exhaustion when the budget runs out between tenants without skipping a queried deal",async()=>{
 // a-0 and a-1 take 80s each: tenant a finishes at 160s, so tenant b is never queried and nothing is counted as skipped.
 const{run,mocks}=await setup(80/60);
 const{body}=await run();
 assert.deepEqual(mocks.calls.map(c=>c.id),["a-0","a-1"]);
 assert.equal(body.timeBudgetSkipped,0);assert.equal(body.timeBudgetExhausted,true);
 assert.equal(mocks.queries.some(q=>q.tenant==="b"),false);
});
test("T16 cron window and attempt cap are the ones the status treats as given up",async()=>{
 // The panel turns a deal that ended before now - MEET_ARTIFACT_LOOKBACK_MS into "needs attention"; that is only
 // right if the cron stops at exactly that age. Deals at the attempt cap are settled as failed by the ingest.
 const{run,mocks}=await setup(0.1);
 await run();
 assert.ok(mocks.queries.length>0);
 for(const q of mocks.queries){
  assert.equal(q.where.meetingEndAt.lt.getTime()-q.where.meetingEndAt.gte.getTime(),phase.MEET_ARTIFACT_LOOKBACK_MS);
  assert.equal(q.where.meetArtifactAttempts.lt,12);
 }
});
