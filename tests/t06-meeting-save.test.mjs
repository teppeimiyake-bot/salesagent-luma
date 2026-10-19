import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
test("T06 minutes save triggers BANT only on changed content with flag enabled",async()=>{
  for(const [minutes,flag,permission,count,status] of [["変更",true,"user",1,200],["元の本文",true,"user",0,200],["変更",false,"user",0,200],["変更",true,"viewer",0,403]]){
    const row={id:"meeting",dealId:"deal",minutes:"元の本文"};const m={count:0,flag,permission,prisma:{
      user:{findUnique:async()=>({permission})},meeting:{findUnique:async()=>({...row}),update:async({data})=>Object.assign(row,data)},aiLog:{create:async()=>({})}}};
    const route=await offlineModule("src/app/api/meetings/[id]/route.ts",m,{
      "@/lib/db":"export const prisma=mocks.prisma;",
      "@/lib/auth":"export const getSession=async()=>({userId:'demo'});export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>p==='user';",
      "@/lib/feature-flags":"export const isAutoBantFeatureEnabled=()=>mocks.flag;",
      "@/lib/ai/summarize-bant":"export const scheduleMeetingBantRefresh=async()=>{mocks.count++};",
      // DELETE-only file cleanup (tested in t22-meeting-delete); PATCH never reaches it.
      "@/lib/storage":"export const deleteFile=async()=>{throw Error('unused')};",
      "@/lib/tenant-context":"export const getRequestTenant=async()=>null;",
      "@/lib/meetings/upload-sessions":"export const isUploadManifestKey=()=>false;export const removeUploadSessionForKey=async()=>{throw Error('unused')};",
      "@/lib/meetings/transcription-files":"export const transcriptionWorkDir=()=>{throw Error('unused')};",
      "node:fs/promises":"export default {};",
    });
    const r=await route.PATCH(new Request("http://offline.invalid",{method:"PATCH",body:JSON.stringify({minutes})}),{params:Promise.resolve({id:"meeting"})});
    assert.equal(r.status,status);assert.equal(m.count,count);if(status===403)assert.equal(row.minutes,"元の本文");
  }
});
