import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
const {measureAiCall,estimateTextCost,forecastMonthly,vertexSearchBilledPerQuery}=createRequire(import.meta.url)("../src/lib/ai/usage.ts");
const execFileAsync=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const rates={input:100,output:200,cacheRead:10,cacheWrite:120,search:2}; // synthetic JPY rates, not real prices
const record={id:"demo",provider:"gemini",model:"demo",feature:"context",startedAt:"2026-09-21T00:00:00Z",elapsedMs:10,status:"success",usage:null};
test("AI SDK inclusive input cache is charged once; unknown/failure is not zero",()=>{
 assert.equal(estimateTextCost({...record,usage:{inputTokens:1000,outputTokens:200,inputTokenDetails:{cacheReadTokens:300,cacheWriteTokens:100}}},rates),0.115);
 for(const r of [record,{...record,status:"error",usage:{inputTokens:2,outputTokens:2}},{...record,usage:{inputTokens:1}},{...record,feature:"transcription",usage:{inputTokens:2,outputTokens:2}}]) assert.equal(estimateTextCost(r,rates),null);
 assert.throws(()=>estimateTextCost(record,{...rates,input:-1}));
});
test("Anthropic separate cache/search costs and monthly fixed costs",()=>{
 const r={...record,provider:"anthropic",feature:"brief",usage:{input_tokens:1000,output_tokens:200,cache_creation_input_tokens:100,cache_read_input_tokens:300,server_tool_use:{web_search_requests:2}}};
 assert.equal(estimateTextCost(r,rates),4.155);
 assert.equal(estimateTextCost({...r,usage:{...r.usage,server_tool_use:undefined}},rates),null);
 assert.equal(forecastMonthly([4,2],[50,50],1000),1300);
 assert.equal(forecastMonthly([null,0],[50,50],1000),null);
 assert.equal(forecastMonthly([0],[50],null),null);
 assert.throws(()=>forecastMonthly([1],[-1],0));
});
test("provider call metrics keep usage/time, never prompt/result text; exceptions remain unknown",async()=>{
 const output=[],previous=console.info;console.info=line=>output.push(line);
 try{
  const value=await measureAiCall({provider:"gemini",model:"demo",feature:"minutes"},async()=>({text:"SECRET_TEXT",usage:{inputTokens:12,outputTokens:2}}),v=>v.usage);
  assert.equal(value.text,"SECRET_TEXT");
  await assert.rejects(measureAiCall({provider:"gemini",model:"demo"},async()=>{throw Error("SECRET_ERROR")},()=>null),/SECRET_ERROR/);
 }finally{console.info=previous}
 assert.equal(output.length,2);assert.equal(output.join("").includes("SECRET"),false);
 const first=JSON.parse(output[0].slice(11)),second=JSON.parse(output[1].slice(11));
 assert.equal(first.feature,"minutes");assert.equal(first.usage.inputTokens,12);assert.ok(first.elapsedMs>=0);assert.equal(second.status,"error");assert.equal(second.usage,null);
});
const vertex={...record,provider:"vertex",model:"gemini-2.5-flash",feature:"minutes",search:false};
const vertexRates={...rates,audioInput:300}; // synthetic JPY/1M audio tokens, not a real price
const text=n=>({modality:"TEXT",tokenCount:n}),audio=n=>({modality:"AUDIO",tokenCount:n});
const without=(object,key)=>Object.fromEntries(Object.entries(object).filter(([k])=>k!==key));
test("Vertex usageMetadata: uncached input, cache read, thinking output and tool-use input",()=>{
 const usage={promptTokenCount:1000,candidatesTokenCount:200,thoughtsTokenCount:50,totalTokenCount:1250,promptTokensDetails:[text(1000)]};
 assert.equal(estimateTextCost({...vertex,usage},rates),0.15);
 // promptTokenCount includes the 300 cached tokens; they are charged once, at the cache rate.
 assert.equal(estimateTextCost({...vertex,usage:{promptTokenCount:1000,cachedContentTokenCount:300,candidatesTokenCount:200,totalTokenCount:1200,promptTokensDetails:[text(1000)],cacheTokensDetails:[text(300)]}},rates),0.113);
 for(const broken of [{...usage,candidatesTokenCount:undefined},{...usage,promptTokenCount:"1000"},{...usage,cachedContentTokenCount:1001},{...usage,promptTokensDetails:[{modality:"AUDIO"}]},{...usage,promptTokensDetails:"TEXT"}])
  assert.equal(estimateTextCost({...vertex,usage:broken},rates),null);
 assert.equal(estimateTextCost({...vertex,status:"error",usage},rates),null);
});
test("Vertex Google Search grounding is charged per request that used search; unknown search use is not free",()=>{
 const usage={promptTokenCount:1000,toolUsePromptTokenCount:500,candidatesTokenCount:200,totalTokenCount:1700};
 assert.equal(estimateTextCost({...vertex,feature:"brief",search:true,usage},rates),2.19);
 assert.equal(estimateTextCost({...vertex,feature:"brief",search:false,usage},rates),0.19);
 // Search-only no-result usage still pays the grounded request.
 assert.equal(estimateTextCost({...vertex,feature:"brief",search:true,usage:{promptTokenCount:187,candidatesTokenCount:0,totalTokenCount:187}},rates),2.0187);
 const {search,...legacy}=vertex;assert.equal(search,false);
 assert.equal(estimateTextCost({...legacy,feature:"brief",usage},rates),null);
 assert.equal(estimateTextCost({...legacy,usage},rates),0.19);
});
test("Gemini 3 Vertex grounding is charged per search query; a missing query count is unknown and search results are not input",()=>{
 const near=(actual,expected)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
 const lite={...vertex,model:"gemini-3.5-flash-lite",feature:"brief"};
 const usage={promptTokenCount:1000,toolUsePromptTokenCount:500,candidatesTokenCount:200,totalTokenCount:1700};
 // 1000 input (the 500 search-result tokens are free) + 200 output = 0.14; 3 queries x 2 JPY.
 near(estimateTextCost({...lite,search:true,searchQueries:3,usage},rates),6.14);
 near(estimateTextCost({...lite,search:true,searchQueries:0,usage},rates),0.14);
 near(estimateTextCost({...lite,search:false,usage},rates),0.14);
 for(const searchQueries of [undefined,null,-1,1.5,"3",Number.POSITIVE_INFINITY])
  assert.equal(estimateTextCost({...lite,search:true,searchQueries,usage},rates),null,String(searchQueries));
 // Thinking after a search that found nothing is still output.
 near(estimateTextCost({...lite,search:true,searchQueries:1,usage:{promptTokenCount:187,candidatesTokenCount:0,thoughtsTokenCount:24,totalTokenCount:211}},rates),2.0235);
 // Gemini 2.x records keep the per-request charge and the tool-use input, whatever query count they carry.
 near(estimateTextCost({...lite,model:"gemini-2.5-flash",search:true,searchQueries:3,usage},rates),2.19);
 for(const [model,perQuery] of [["gemini-2.5-flash",false],["gemini-2.0-flash",false],["gemini-2",false],["gemini-3.5-flash-lite",true],["gemini-3-flash-preview",true],["gemini-10.0-pro",true],["unexpected",true],["gemini-x",true]])
  assert.equal(vertexSearchBilledPerQuery(model),perQuery,model);
});
test("Vertex audio input uses its own configured rate; missing audio price or modality is unknown, never zero",()=>{
 const r={...vertex,feature:"transcription",usage:{promptTokenCount:1100,candidatesTokenCount:200,totalTokenCount:1300,promptTokensDetails:[text(100),audio(1000)]}};
 assert.equal(estimateTextCost(r,vertexRates),0.35);
 assert.equal(estimateTextCost(r,rates),null);
 assert.equal(estimateTextCost(r,{...rates,audioInput:null}),null);
 assert.throws(()=>estimateTextCost(r,{...rates,audioInput:-1}));
 assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokensDetails:undefined}},vertexRates),null);
 // Cached text alongside audio is priced; cached audio (own discounted price) or an unknown cache split is not.
 const cachedText={promptTokenCount:1300,cachedContentTokenCount:100,candidatesTokenCount:200,totalTokenCount:1500,promptTokensDetails:[text(300),audio(1000)],cacheTokensDetails:[text(100)]};
 assert.equal(estimateTextCost({...r,usage:cachedText},vertexRates),0.361);
 assert.equal(estimateTextCost({...r,usage:{...cachedText,cacheTokensDetails:[audio(100)]}},vertexRates),null);
 assert.equal(estimateTextCost({...r,usage:{...cachedText,cacheTokensDetails:undefined}},vertexRates),null);
 // Text-only Vertex calls do not need an audio price.
 assert.equal(estimateTextCost({...vertex,usage:{promptTokenCount:1000,candidatesTokenCount:200,totalTokenCount:1200}},rates),0.14);
});
test("Vertex transcription needs reported AUDIO tokens and a breakdown that adds up; the remainder is never priced as text",()=>{
 const r={...vertex,feature:"transcription",usage:{promptTokenCount:1000,candidatesTokenCount:0,totalTokenCount:1000,promptTokensDetails:[text(1000)]}};
 // Transcription always sends audio: a breakdown with no AUDIO tokens is unknown, not 0.14 at the text rate.
 for(const promptTokensDetails of [[text(1000)],[],[text(1000),audio(0)]]) assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokensDetails}},vertexRates),null);
 // Partial coverage (4,990 unexplained tokens) or an over-count is unknown, for any feature.
 assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokenCount:5000,promptTokensDetails:[audio(10)]}},vertexRates),null);
 assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokensDetails:[text(100),audio(1000)]}},vertexRates),null);
 assert.equal(estimateTextCost({...vertex,usage:{...r.usage,promptTokensDetails:[text(500)]}},vertexRates),null);
 // An unknown modality might be audio; a cache breakdown must add up to the cached count as well.
 assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokensDetails:[{tokenCount:100},audio(900)]}},vertexRates),null);
 assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokensDetails:[{modality:"MODALITY_UNSPECIFIED",tokenCount:100},audio(900)]}},vertexRates),null);
 assert.equal(estimateTextCost({...r,usage:{...r.usage,cachedContentTokenCount:100,promptTokensDetails:[text(100),audio(900)],cacheTokensDetails:[text(50)]}},vertexRates),null);
 // A complete breakdown with audio is priced: 100 text * 100 + 900 audio * 300 per 1M tokens.
 assert.equal(estimateTextCost({...r,usage:{...r.usage,promptTokensDetails:[text(100),audio(900)]}},vertexRates),0.28);
 // Other modalities that add up keep the text rate (image/video share it on Gemini 2.5 Flash).
 assert.equal(estimateTextCost({...vertex,usage:{...r.usage,promptTokensDetails:[text(400),{modality:"IMAGE",tokenCount:600}]}},rates),0.1);
});
test("every required rate key must be present; a missing one throws instead of pricing NaN",()=>{
 const usage={promptTokenCount:1000,candidatesTokenCount:200,totalTokenCount:1200};
 for(const key of ["input","output","cacheRead","cacheWrite","search"]){
  assert.throws(()=>estimateTextCost({...vertex,usage},without(rates,key)),/Invalid rates/);
  assert.throws(()=>estimateTextCost({...vertex,usage},{...rates,[key]:undefined}),/Invalid rates/);
 }
 for(const bad of [undefined,null,{...rates,audioInput:"300"},{...rates,extra:Number.NaN}]) assert.throws(()=>estimateTextCost({...vertex,usage},bad),/Invalid rates/);
 // Vertex has no cache write: 0 is a valid rate; audioInput stays optional.
 assert.equal(estimateTextCost({...vertex,usage},{...rates,cacheWrite:0}),0.14);
});
test("cost report prices Vertex only from configured rates and has no default budget",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"t19-report-")),log=path.join(dir,"app.log"),config=path.join(dir,"config.json");
 const run=async(rateTable,env={})=>{
  await fs.writeFile(config,JSON.stringify({rates:rateTable,samples:{minutes:1,brief:1},monthlyCount:50,fixedMonthlyJpy:null}));
  const {stdout}=await execFileAsync(process.execPath,["--import","tsx","scripts/report-ai-cost.mts",log,config],{cwd:root,env:{...process.env,LUMA_AI_COST_REPORT_BUDGET_JPY:"",...env}});
  return JSON.parse(stdout);
 };
 try{
  const minutes={...vertex,id:"m1",usage:{promptTokenCount:1000,candidatesTokenCount:200,totalTokenCount:1200}};
  const brief={...vertex,id:"b1",feature:"brief",search:true,usage:{promptTokenCount:1000,toolUsePromptTokenCount:500,candidatesTokenCount:200,totalTokenCount:1700}};
  await fs.writeFile(log,[minutes,brief,minutes].map(r=>"info [ai-usage] "+JSON.stringify(r)).join("\n"));
  const unpriced=await run({});
  assert.equal(unpriced.estimatedJpy,null);assert.equal(unpriced.verificationBudgetJpy,null);assert.equal(unpriced.remainingJpy,null);
  const table={"vertex/gemini-2.5-flash":{values:rates,source:"synthetic test rate",verifiedAt:"2026-09-25"}};
  const priced=await run(table);
  assert.equal(priced.calls,2);assert.equal(priced.features.find(f=>f.feature==="brief").totalJpy,2.19);
  assert.equal(priced.estimatedJpy,2.33);assert.equal(priced.verificationBudgetJpy,null);assert.equal(priced.remainingJpy,null);
  const budgeted=await run(table,{LUMA_AI_COST_REPORT_BUDGET_JPY:"100"});
  assert.equal(budgeted.verificationBudgetJpy,100);assert.equal(budgeted.remainingJpy,97.67);
  await assert.rejects(run(table,{LUMA_AI_COST_REPORT_BUDGET_JPY:"-1"}));
  // An omitted Vertex cacheWrite stops the report with the entry to fix, not a NaN/"Invalid cost" crash.
  await assert.rejects(run({"vertex/gemini-2.5-flash":{...table["vertex/gemini-2.5-flash"],values:without(rates,"cacheWrite")}}),/Invalid rates: vertex\/gemini-2\.5-flash/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test("cost report: the monthly forecast covers the five per-meeting features and leaves the long-record extraction out",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"t19-forecast-")),log=path.join(dir,"app.log"),config=path.join(dir,"config.json");
 try{
  const features=["brief","minutes","bant","context","transcription","meeting_extract"];
  const usage={promptTokenCount:1000,candidatesTokenCount:200,totalTokenCount:1200};
  // Transcription is priced only with a complete breakdown that includes the audio tokens.
  const lines=features.map((feature,i)=>({...vertex,id:`f${i}`,feature,search:false,
   usage:feature==="transcription"?{promptTokenCount:1000,candidatesTokenCount:0,totalTokenCount:1000,promptTokensDetails:[text(100),audio(900)]}:usage}));
  await fs.writeFile(log,lines.map(r=>"info [ai-usage] "+JSON.stringify(r)).join("\n"));
  const table={"vertex/gemini-2.5-flash":{values:vertexRates,source:"synthetic test rate",verifiedAt:"2026-09-28"}};
  await fs.writeFile(config,JSON.stringify({rates:table,samples:Object.fromEntries(features.map(f=>[f,1])),monthlyCount:10,fixedMonthlyJpy:0}));
  const {stdout}=await execFileAsync(process.execPath,["--import","tsx","scripts/report-ai-cost.mts",log,config],{cwd:root,env:{...process.env,LUMA_AI_COST_REPORT_BUDGET_JPY:""}});
  const report=JSON.parse(stdout);
  const unit=f=>report.features.find(r=>r.feature===f).unitJpy;
  assert.ok(unit("meeting_extract")>0,"the extraction cost is still reported per feature");
  const expected=["brief","minutes","bant","context","transcription"].reduce((sum,f)=>sum+unit(f)*10,0);
  assert.ok(Math.abs(report.monthlyJpy-expected)<1e-9,`${report.monthlyJpy} vs ${expected}`);
  assert.match(report.notes.join("\n"),/meeting_extract/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
