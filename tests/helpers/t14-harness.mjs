import {offlineModule} from "./offline-module.mjs";
const entry="src/app/api/quotes/[id]/finalize/route.ts";
export const quoteBoundaries={
 "@/lib/db":"export const prisma=mocks.prisma;",
 "@/lib/auth":"export const getSession=async()=>({userId:mocks.userId});export const getCurrentPermission=async()=>mocks.permission??'user';export const hasPermission=p=>['user','admin'].includes(p);",
 "@/lib/storage":"export class StorageConfigError extends Error {};export const putFile=async()=>{if(mocks.failStorage)throw new StorageConfigError('test missing storage');mocks.uploads++;return {url:'/local/quote.pdf'}};export const deleteFile=async()=>{mocks.deleted++};",
 "@/lib/pdf/render":"export const renderPdfBuffer=async(el)=>{mocks.rendered=el?.props?.data;if(mocks.duringRender)await mocks.duringRender();return Buffer.from('test pdf')};",
 "@/lib/pdf/quote-pdf":"export const QuotePdf=()=>null;export const QuotePdfV2=()=>null;",
 "@/lib/feature-flags":"export const isQuotePdfV2Enabled=()=>true;",
 // ロゴの取得（外部へ出ない偽物）。mocks.logoResult が無ければ取得できた扱い。
 "@/lib/quote-logo":"export const LOGO_ISSUE_TIMEOUT_MS=4000;export const fetchQuoteLogo=async(url,o)=>{(mocks.logoCalls??=[]).push({url,timeoutMs:o?.timeoutMs});return mocks.logoResult??{ok:true,dataUrl:'data:image/png;base64,iVBORw0KGgo='};};",
};
export const loadFinalize=m=>offlineModule(entry,m,quoteBoundaries,[entry,"src/lib/quote-calculation.ts","src/lib/quote-issuer.ts","src/lib/quote-logo-pdf.ts"],["next/server","react","node:crypto"]);
export const finalize=(r,body={})=>r.POST(new Request("http://offline.invalid",{method:"POST",body:JSON.stringify(body)}),{params:Promise.resolve({id:"quote"})});
