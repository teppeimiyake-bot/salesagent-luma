import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bundleT01Sources,connectDevelopment,newFixture,seedFixture } from "./lib/t01-development.mjs";
import { offlineModule } from "../tests/helpers/offline-module.mjs";
const compiled=await bundleT01Sources(),fixture=newFixture(),userId=randomUUID();
fixture.tag=fixture.tag.replace("t01-","t10-");
const env=await connectDevelopment(compiled,fixture),rollback=Error("EXPECTED_ROLLBACK");
let checks=0;const equal=(a,b)=>{assert.equal(a,b);checks++};
try {
 await assert.rejects(env.prisma.$transaction(async tx=>{
  await seedFixture(tx,fixture);
  await tx.user.create({data:{id:userId,email:`${fixture.tag}@example.invalid`,name:"デモ担当",permission:"user"}});
  const mocks={prisma:tx,userId,run:async id=>tx.preparationBrief.update({where:{id},data:{status:"done",industrySummary:"確認できず",proposalStory:"# つかみ\n架空の検証用",sources:[]}})};
  const route=await offlineModule("src/app/api/deals/[id]/preparation/route.ts",mocks,{
   "@/lib/db":"export const prisma=mocks.prisma;",
   "@/lib/auth":"export const getSession=async()=>({userId:mocks.userId});export const hasPermission=(p,required)=>required==='admin'?p==='admin':['user','admin'].includes(p);",
   "@/lib/feature-flags":"export const isPreparationV2Enabled=()=>true;",
   "@/lib/ai/anthropic":"export const callClaudeJSON=()=>{throw Error('AI forbidden')};",
   "@/lib/ai/luma-context":"export const formatLumaContextForPrompt=()=>'';export const getLumaContextText=()=>'';",
   "@/lib/ai/preparation":"export const PREPARATION_DISCLAIMER='AIによる仮説です';export const canCreatePreparationBrief=({createdToday,isAdmin,limit})=>isAdmin||createdToday<limit;export const runPreparationBrief=id=>mocks.run(id);",
  },["src/app/api/deals/[id]/preparation/route.ts","src/lib/preparation-cron.ts"]);
  const params={params:Promise.resolve({id:fixture.deal})};
  for(let i=0;i<3;i++)equal((await route.POST(new Request("http://offline.invalid",{method:"POST"}),params)).status,202);
  equal((await route.POST(new Request("http://offline.invalid",{method:"POST"}),params)).status,429);
  const history=await (await route.GET(new Request("http://offline.invalid?history=1"),params)).json();
  equal(history.briefs.length,3);equal(new Set(history.briefs.map(x=>x.id)).size,3);equal(history.briefs[0].status,"done");
  const latest=await (await route.GET(new Request("http://offline.invalid"),params)).json();equal(latest.brief.id,history.briefs[0].id);
  const ownTenant=env.dependencies.context.tenantId;env.dependencies.context.tenantId=randomUUID();
  equal((await route.GET(new Request("http://offline.invalid"),params)).status,404);env.dependencies.context.tenantId=ownTenant;
  throw rollback;
 },{maxWait:15000,timeout:60000}),e=>e===rollback);
 for(const [model,id] of [["deal",fixture.deal],["tenant",fixture.tenant],["company",fixture.company],["user",userId]])equal(await env.base[model].count({where:{id}}),0);
 equal(await env.base.preparationBrief.count({where:{dealId:fixture.deal}}),0);
 console.log(`T10_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_ROLLED_BACK_AI_CALLS_0`);
} finally {await env.close()}
