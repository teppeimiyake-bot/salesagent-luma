import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {bundleT01Sources,connectDevelopment,newFixture,seedFixture} from "./lib/t01-development.mjs";
import {offlineModule} from "../tests/helpers/offline-module.mjs";
const fixture=newFixture(),userId=randomUUID(),quoteId=randomUUID();fixture.tag=fixture.tag.replace("t01-","t17-");
const env=await connectDevelopment(await bundleT01Sources(),fixture),rollback=Error("EXPECTED_ROLLBACK");
let checks=0;const eq=(a,b)=>{assert.equal(a,b);checks++};
const boundaries={
 "@/lib/db":"export const prisma=mocks.prisma;",
 "@prisma/client":"export const Prisma=mocks.Prisma;",
 "@/lib/auth":"export const getCurrentPermission=async()=>mocks.permission;export const getSession=async()=>({userId:mocks.userId});export const hasPermission=(p,r)=>({viewer:1,user:2,admin:3}[p]??0)>=({viewer:1,user:2,admin:3}[r]??99);",
 "@/lib/feature-flags":"export const isQuotePdfV2Enabled=()=>true;",
};
const req=(method,body)=>new Request("http://offline.invalid/",{method,...(body?{body:JSON.stringify(body)}:{})});
const params=id=>({params:Promise.resolve({id})});
try {
 await assert.rejects(env.prisma.$transaction(async tx=>{
  await seedFixture(tx,fixture);
  await tx.user.create({data:{id:userId,email:`${fixture.tag}@example.invalid`,name:"架空テンプレ担当",permission:"admin"}});
  const mocks={userId,permission:"admin",Prisma:env.dependencies.generated.Prisma,prisma:new Proxy(tx,{get:(target,p)=>p==="$transaction"?async fn=>fn(tx):target[p]})};
  const load=entry=>offlineModule(entry,mocks,boundaries,[entry,"src/lib/quote-template-server.ts","src/lib/quote-version.ts"]);
  const list=await load("src/app/api/quote-templates/route.ts"),single=await load("src/app/api/quote-templates/[id]/route.ts"),save=await load("src/app/api/quotes/[id]/save-as-template/route.ts"),revise=await load("src/app/api/quotes/[id]/revise/route.ts");
  const data={name:"  架空標準プラン  ",lines:[{name:"制作費",qty:1,unitPrice:580000},{name:"交通費",qty:1,unitPrice:5010,taxCategory:"non_taxable"}]};
  eq((await list.POST(req("POST",{...data,name:"　 "}))).status,400);
  eq((await list.POST(req("POST",{...data,lines:[{name:"  "}]}))).status,400);
  mocks.permission="viewer";eq((await list.POST(req("POST",data))).status,403);mocks.permission="admin";
  let res=await list.POST(req("POST",data));eq(res.status,200);const template=(await res.json()).template;
  eq(template.name,"架空標準プラン");eq(template.lines.length,2);eq(template.lines[1].taxRate,0);
  eq((await (await list.GET()).json()).templates.length,1);
  res=await single.PATCH(req("PATCH",{name:"架空修正プラン",lines:[{name:"更新明細",unitPrice:500}]}),params(template.id));eq(res.status,200);eq((await res.json()).template.lines.length,1);
  eq(await tx.quoteTemplateLine.count({where:{templateId:template.id}}),1);
  const own=env.dependencies.context.tenantId;env.dependencies.context.tenantId=randomUUID();
  eq((await single.GET(req("GET"),params(template.id))).status,404);eq((await (await list.GET()).json()).templates.length,0);env.dependencies.context.tenantId=own;
  eq((await single.DELETE(req("DELETE"),params(template.id))).status,200);
  eq((await (await list.GET()).json()).templates.length,0);eq((await tx.quoteTemplate.findUnique({where:{id:template.id}})).active,false);
  await tx.quote.create({data:{id:quoteId,dealId:fixture.deal,clientName:"架空テスト社",status:"final",version:"v1",quoteNumber:"T17-DEMO-1",lines:{create:[{name:"改訂対象",qty:2,unitPrice:100,unit:"本"}]}}});
  res=await revise.POST(req("POST"),params(quoteId));eq(res.status,200);const revised=(await res.json()).quote;
  eq(revised.status,"draft");eq(revised.supersedesQuoteId,quoteId);eq(revised.version,"v2");eq(revised.quoteNumber,null);eq(revised.lines[0].unit,"本");
  eq((await tx.quote.findUnique({where:{id:quoteId}})).status,"final");
  eq((await revise.POST(req("POST"),params(revised.id))).status,409);
  mocks.permission="user";
  eq((await save.POST(req("POST",{name:"　"}),params(quoteId))).status,400);
  res=await save.POST(req("POST",{name:"架空見積から登録"}),params(quoteId));eq(res.status,200);
  const copied=(await res.json()).template;eq(copied.lines[0].unitPrice,100);eq(copied.lines[0].qty,2);
  throw rollback;
 },{maxWait:15000,timeout:60000}),e=>e===rollback);
 for(const model of ["quote","quoteTemplate","quoteTemplateLine"])eq(await env.base[model].count({where:{tenantId:fixture.tenant}}),0);
 console.log(`T17_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_ROLLED_BACK`);
}finally{await env.close()}
