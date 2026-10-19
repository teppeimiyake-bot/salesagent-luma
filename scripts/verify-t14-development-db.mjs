import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {bundleT01Sources,connectDevelopment,newFixture,seedFixture} from "./lib/t01-development.mjs";
import {loadFinalize} from "../tests/helpers/t14-harness.mjs";
const fixture=newFixture(),userId=randomUUID(),quoteId=randomUUID();fixture.tag=fixture.tag.replace("t01-","t14-");
const env=await connectDevelopment(await bundleT01Sources(),fixture),rollback=Error("EXPECTED_ROLLBACK");
let checks=0;const equal=(a,b)=>{assert.equal(a,b);checks++};
try{
 await assert.rejects(env.prisma.$transaction(async tx=>{
  await seedFixture(tx,fixture);await tx.user.create({data:{id:userId,email:`${fixture.tag}@example.invalid`,name:"架空見積担当",permission:"user"}});
  await tx.quote.create({data:{id:quoteId,dealId:fixture.deal,clientName:"架空テスト社",lines:{create:[{name:"検証制作費",qty:1,unitPrice:580000},{name:"検証交通費",qty:1,unitPrice:5010,taxCategory:"non_taxable",taxRate:0}]}}});
  const mocks={userId,uploads:0,deleted:0,prisma:new Proxy(tx,{get:(target,p)=>p==="$transaction"?async fn=>fn(tx):target[p]})};
  const route=await loadFinalize(mocks),params={params:Promise.resolve({id:quoteId})};
  const post=()=>route.POST(new Request("http://offline.invalid",{method:"POST",body:"{}"}),params);
  equal((await post()).status,200);equal((await post()).status,200);equal(mocks.uploads,1);
  const saved=await tx.quote.findUnique({where:{id:quoteId}});equal(saved.grandTotal,643010);equal(saved.status,"final");equal(Boolean(saved.quoteNumber),true);
  equal(await tx.document.count({where:{dealId:fixture.deal,category:"quote"}}),1);
  const own=env.dependencies.context.tenantId;env.dependencies.context.tenantId=randomUUID();equal((await post()).status,404);env.dependencies.context.tenantId=own;
  throw rollback;
 },{maxWait:15000,timeout:60000}),e=>e===rollback);
 for(const [model,id]of[["quote",quoteId],["deal",fixture.deal],["tenant",fixture.tenant],["user",userId]])equal(await env.base[model].count({where:{id}}),0);
 equal(await env.base.document.count({where:{dealId:fixture.deal}}),0);
 equal(await env.base.quoteIssuerProfile.count({where:{tenantId:fixture.tenant}}),0);
 console.log(`T14_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_ROLLED_BACK_STORAGE_MOCKED`);
}finally{await env.close()}
