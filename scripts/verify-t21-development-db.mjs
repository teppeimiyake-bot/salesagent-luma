import assert from "node:assert/strict";
import {bundleT01Sources,connectDevelopment,newFixture,seedFixture,routeRequest} from "./lib/t01-development.mjs";
import {offlineModule} from "../tests/helpers/offline-module.mjs";
const fixture=newFixture(),env=await connectDevelopment(await bundleT01Sources(),fixture),rollback=Error("EXPECTED_ROLLBACK");
let checks=0;const eq=(a,b)=>{assert.equal(a,b);checks++};
try{
 await assert.rejects(env.prisma.$transaction(async tx=>{
  await seedFixture(tx,fixture);env.dependencies.prisma=tx;
  // Rebind the real PATCH route to this rollback-only transaction.
  const{loadSource}=await import("./lib/t01-development.mjs");
  const route=loadSource(await bundleT01Sources(),"route",env.dependencies);
  const mocks={prisma:{deal:tx.deal,user:{findUnique:async()=>({permission:"user"})}},called:0};
  const guards={"@/lib/db":"export const prisma=mocks.prisma;","@/lib/auth":"export const getSession=async()=>({userId:'demo'});export const hasPermission=()=>true;","@/lib/feature-flags":"export const isMeetAutoRecordEnabled=()=>true;","@/lib/meetings/meet-ingest":"export const configureDealMeetArtifacts=async()=>{mocks.called++;return {ok:true}};export const ingestDealMeetArtifacts=async()=>{mocks.called++;return {ok:true}};"};
  const endpoints=[];for(const name of ["configure","artifacts"])endpoints.push(await offlineModule(`src/app/api/deals/[id]/meet/${name}/route.ts`,mocks,guards));
  env.dependencies.permission="viewer";eq((await routeRequest(route,fixture,{meetingOwnerType:"own_meet"})).status,403);
  env.dependencies.permission="user";
  for(const owner of ["own_meet","guest_meet","zoom","in_person","unknown"]){
   eq((await routeRequest(route,fixture,{meetingOwnerType:owner})).status,200);
   eq((await tx.deal.findUnique({where:{id:fixture.deal}})).meetingOwnerType,owner);
   for(const endpoint of endpoints)eq((await endpoint.POST(new Request("http://offline.invalid",{method:"POST"}),{params:Promise.resolve({id:fixture.deal})})).status,owner==="own_meet"?200:409);
  }
  eq(mocks.called,2);
  eq((await routeRequest(route,fixture,{meetingOwnerType:"invalid"})).status,400);
  throw rollback;
 },{maxWait:15000,timeout:60000}),e=>e===rollback);
 eq(await env.base.deal.count({where:{id:fixture.deal}}),0);
 console.log(`T21_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_ROLLED_BACK_GOOGLE_MOCKED`);
}finally{await env.close()}
