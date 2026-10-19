import assert from "node:assert/strict";
import test from "node:test";
import {offlineModule} from "./helpers/offline-module.mjs";
const entry="src/app/api/cron/meet-artifacts/route.ts";
async function setup(){
 const mocks={valid:true,enabled:true,tenant:null,queries:[],calls:[]};
 mocks.prisma={deal:{findMany:async query=>{
  mocks.queries.push(query);
  return Array.from({length:Math.min(query.take,mocks.tenant==="a"?2:5)},(_,i)=>({id:`${mocks.tenant}-${i}`}));
 }}};
 const route=await offlineModule(entry,mocks,{
  "@/lib/db":"export const prisma=mocks.prisma;export const prismaUnscoped={tenant:{findMany:async()=>[{code:'a'},{code:'b'}]}};",
  "@/lib/agent-auth":"export const isValidCronSecret=()=>mocks.valid;",
  "@/lib/feature-flags":"export const isMeetAutoRecordEnabled=()=>mocks.enabled;",
  "@/lib/tenant-context":"export const runAsTenant=async(code,fn)=>{mocks.tenant=code;return fn()};",
  "@/lib/meetings/meet-ingest":"export const MEET_ARTIFACT_MAX_ATTEMPTS=12;export const ingestDealMeetArtifacts=async(id)=>{mocks.calls.push({id,tenant:mocks.tenant});return {status:'waiting',message:'mock'}};",
 });return{route,mocks};
}
test("disabled or unauthenticated artifact jobs do not access deals or call Google",async()=>{
 const{route,mocks}=await setup(),req=new Request("http://offline.invalid");
 mocks.valid=false;assert.equal((await route.GET(req)).status,401);
 mocks.valid=true;mocks.enabled=false;assert.equal((await (await route.GET(req)).json()).skipped,true);
 assert.equal(mocks.calls.length,0);assert.equal(mocks.queries.length,0);
});
test("existing Meet path restricts owner/age/attempts, tenant context and five jobs",async()=>{
 const{route,mocks}=await setup();
 const body=await(await route.GET(new Request("http://offline.invalid"))).json();
 assert.equal(body.processed,5);assert.equal(mocks.calls.length,5);
 for(const q of mocks.queries){assert.equal(q.where.meetingOwnerType,"own_meet");assert.equal(q.where.deletedAt,null);assert.equal(q.where.company.deletedAt,null);assert.equal(q.where.meetArtifactAttempts.lt,12);assert.ok(q.take<=5);assert.equal(q.where.meetingEndAt.lt-q.where.meetingEndAt.gte,7*86400000)}
 assert.ok(mocks.calls.every(c=>c.id.startsWith(c.tenant+"-")));
});
