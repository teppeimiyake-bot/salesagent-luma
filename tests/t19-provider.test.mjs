import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import vm from "node:vm";
import {build} from "esbuild";
import {offlineModule} from "./helpers/offline-module.mjs";
const measured = mocks => async(info,call,usage)=>{
 const result=await call();mocks.calls.push({...info,usage:usage(result)});return result;
};
test("JSON provider routing preserves the Vertex response schema",async()=>{
 const mocks={calls:[]};
 const entry="src/lib/ai/anthropic.ts";
 const route=await offlineModule(entry,mocks,{
  "./usage":"export const measureAiCall=()=>{throw Error('unexpected measure')};",
  "./gemini":"export const geminiCallText=()=>{throw Error('unexpected Gemini')};",
  "./vertex":"export const vertexGenerate=async p=>{mocks.calls.push(p);return {text:'{\"scores\":{\"actionability\":4,\"specificity\":4,\"impact\":4}}'}};",
  "./provider":"export const getHeavyTextProvider=()=> 'vertex';export const getTextProvider=()=> 'vertex';export const hasAnthropicKey=()=>false;",
  "@anthropic-ai/sdk":"export default class Anthropic {}",
 },[entry]);
 const responseSchema={type:"OBJECT",required:["scores"]};
 const result=await route.callClaudeJSON({system:"test",user:"fictional",maxTokens:400,responseSchema});
 assert.equal(result.scores.actionability,4);
 assert.equal(mocks.calls.length,1);
 assert.equal(mocks.calls[0].json,true);
 assert.equal(mocks.calls[0].responseSchema,responseSchema);
 assert.equal(mocks.calls[0].maxTokens,400);
});
test("Gemini records total SDK usage and feature without changing output or no-key fallback",async()=>{
 const mocks={calls:[],hasKey:true};mocks.measure=measured(mocks);
 const entry="src/lib/ai/gemini.ts";
 const route=await offlineModule(entry,mocks,{
  "./usage":"export const measureAiCall=mocks.measure;",
  "ai":"export const generateText=async()=>({text:'demo',usage:{inputTokens:1},totalUsage:{inputTokens:20,outputTokens:4}});",
  "@ai-sdk/google":"export const google=n=>n;export const createGoogleGenerativeAI=()=>n=>n;",
  "./google-auth":"export const getGoogleAccessToken=async()=>{throw Error('no auth in tests')};",
  "@google/generative-ai":"export class GoogleGenerativeAI{}",
  "@google/generative-ai/server":"export const FileState={};export class GoogleAIFileManager{}",
  "undici":"export class Agent{};export const fetch=()=>{throw Error('forbidden')};",
  "./provider":"export const hasGeminiKey=()=>mocks.hasKey;export const getGeminiModels=()=>({default:'demo'});export const getGoogleBackend=()=>'aistudio';export const getTranscribeBackend=()=>'aistudio';export const getVertexConfig=()=>({project:'',location:'global'});export const isFailFast=()=>false;",
 },[entry],["node:fs","node:path"]);
 assert.equal(await route.geminiCallText({system:"private",user:"private",feature:"bant"}),"demo");
 assert.equal(mocks.calls[0].feature,"bant");assert.equal(mocks.calls[0].usage.inputTokens,20);
 mocks.hasKey=false;assert.equal(await route.geminiCallText({system:"",user:""}),null);assert.equal(mocks.calls.length,1);
});
test("Anthropic tool continuation records every billable turn",async()=>{
 const mocks={calls:[],turn:0};mocks.measure=measured(mocks);
 const entry="src/lib/ai/anthropic.ts";
 const route=await offlineModule(entry,mocks,{
  "./usage":"export const measureAiCall=mocks.measure;",
  "./gemini":"export const geminiCallText=async()=>null;",
  "./vertex":"export const vertexGenerate=()=>{throw Error('Vertex must not run for Anthropic')};",
  "./provider":"export const getHeavyTextProvider=()=> 'anthropic';export const getTextProvider=()=> 'anthropic';export const hasAnthropicKey=()=>true;",
  "@anthropic-ai/sdk":`export default class Anthropic {messages={create:async()=>({content:[{type:'text',text:'{"ok":true}'}],stop_reason:++mocks.turn===1?'pause_turn':'end_turn',usage:{input_tokens:10,output_tokens:3,server_tool_use:{web_search_requests:1}}})}}`,
 },[entry]);
 const result=await route.callClaudeHeavyJSONWithTools({system:"private",user:"private",feature:"brief",tools:[{}]});
 assert.equal(result.parsed.ok,true);assert.equal(mocks.calls.length,2);assert.equal(mocks.calls[1].feature,"brief");assert.equal(mocks.calls[0].usage.server_tool_use.web_search_requests,1);
});
test("Vertex records Google Search use and its query count so grounding fees can be counted",async()=>{
 const require=createRequire(import.meta.url),logs=[];
 const env={LUMA_DEPLOYMENT_ENV:"development",K_SERVICE:"luma-platform-development",GOOGLE_CLOUD_PROJECT:"lumaagentlist",LUMA_DEVELOPMENT_PROJECT_ID:"lumaagentlist",LUMA_CLOUD_AI_MODE:"vertex",AI_PROVIDER:"vertex",AI_PROVIDER_HEAVY:"vertex",VERTEX_LOCATION:"global",VERTEX_MODEL:"gemini-3.5-flash-lite",LUMA_VERTEX_BUDGET_JPY:"45000",LUMA_DEVELOPMENT_UPLOAD_BUCKET:"lumaagentlist-luma-dev-uploads"};
 class PolicyDate extends Date{constructor(...a){super(...(a.length?a:["2026-09-23T00:00:00.000Z"]))}static now(){return Date.parse("2026-09-23T00:00:00.000Z")}}
 const bundle=await build({entryPoints:["src/lib/ai/vertex.ts"],bundle:true,write:false,platform:"node",format:"cjs",packages:"external",logLevel:"silent"});
 const loaded={exports:{}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module:loaded,exports:loaded.exports,require,process:{env},Buffer,URL,Date:PolicyDate,setTimeout,clearTimeout,AbortSignal,
  console:{info:line=>logs.push(line),error(){}},fetch(){throw Error("External network forbidden")}});
 let generation=1,ledger={version:1,scope:"luma-platform-development",limitJpy:45000,attempts:[]};
 const store={async read(){return {generation:String(generation),ledger:structuredClone(ledger)}},async write(expected,next){if(expected!==String(generation))return false;ledger=structuredClone(next);generation++;return true}};
 const request=async url=>url.endsWith(":countTokens")?Response.json({totalTokens:5}):Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"fictional"}]},groundingMetadata:{webSearchQueries:["private","private"]}}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:4,totalTokenCount:9}});
 await loaded.exports.vertexGenerate({system:"private",user:"private",feature:"brief",search:true},{request,store});
 await loaded.exports.vertexGenerate({system:"private",user:"private",feature:"minutes"},{request,store});
 const measured=logs.filter(line=>line.startsWith("[ai-usage] ")).map(line=>JSON.parse(line.slice(11)));
 assert.deepEqual(measured.map(r=>[r.provider,r.model,r.feature,r.search,r.searchQueries]),[["vertex","gemini-3.5-flash-lite","brief",true,2],["vertex","gemini-3.5-flash-lite","minutes",false,undefined]]);
 assert.equal(logs.join("").includes("private"),false);
});
