import test from "node:test";
import assert from "node:assert/strict";
import {loadFinalize,finalize} from "./helpers/t14-harness.mjs";
function setup(){
 const row={id:"quote",tenantId:"tenant",dealId:"deal",status:"draft",clientName:"架空社",clientHonorific:"御中",issueDate:new Date(),updatedAt:new Date(),quoteNumber:null,idempotencyKey:null,lines:[{name:"架空",qty:1,unitPrice:100,unit:"式",taxCategory:"taxable",taxRate:10}]};
 const m={row,uploads:0,deleted:0,docs:0};
 const tx={quote:{findUnique:async()=>structuredClone(row),update:async({data})=>{Object.assign(row,data);row.updatedAt=new Date(row.updatedAt.getTime()+1);return structuredClone(row)}},
 quoteIssuerProfile:{findFirst:async()=>({legalName:"架空社",postalCode:"",addressLine1:"",addressLine2:"",numberPrefix:"D",nextQuoteNumber:1}),update:async()=>({})},
 document:{create:async()=>{m.docs++;return {id:"document"}}},$executeRaw:async()=>{}};
 m.prisma={...tx,$transaction:async fn=>fn(tx)};return m;
}
test("T14 finalize/retry creates one document; final content cannot be reissued",async()=>{
 const m=setup(),r=await loadFinalize(m);assert.equal((await finalize(r)).status,200);assert.equal((await finalize(r)).status,200);assert.equal(m.docs,1);assert.equal(m.uploads,1);assert.equal(m.row.grandTotal,110);
});
test("T14 rejects invalid idempotency input and storage failure",async()=>{
 const m=setup(),r=await loadFinalize(m);assert.equal((await finalize(r,{idempotencyKey:123})).status,400);assert.equal(m.uploads,0);
 m.failStorage=true;assert.equal((await finalize(r)).status,503);assert.equal(m.docs,0);assert.equal(m.row.status,"draft");
});
test("T14 edit during rendering rejects stale PDF and removes temporary upload",async()=>{
 const m=setup();m.duringRender=async()=>{m.row.updatedAt=new Date(m.row.updatedAt.getTime()+10);m.row.clientName="編集後"};
 const r=await loadFinalize(m);assert.equal((await finalize(r)).status,409);assert.equal(m.docs,0);assert.equal(m.deleted,1);assert.equal(m.row.clientName,"編集後");
});
