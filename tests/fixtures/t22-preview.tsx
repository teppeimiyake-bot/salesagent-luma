import {createRoot} from "react-dom/client";
import {UploadRecording} from "../../src/components/deals/upload-recording";
declare global {interface Window{uploadTest:{uploads:number;analyses:number;fail:boolean;pending:boolean}}}
window.uploadTest={uploads:0,analyses:0,fail:true,pending:false};
window.fetch=async(input)=>{
 const url=String(input),t=window.uploadTest;
 if(url==="/api/meetings"){t.uploads++;return Response.json({meeting:{id:"demo",transcript:t.pending?null:"顧客: 予算250万円"}},{status:201})}
 if(url.endsWith("/status"))return Response.json({error:"Unauthorized"},{status:401});
 t.analyses++;if(t.fail)throw Error("offline");return Response.json({ok:true});
};
createRoot(document.getElementById("root")!).render(<UploadRecording dealId="demo"/>);
