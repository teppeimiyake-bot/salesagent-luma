import { createRoot } from "react-dom/client";
import { MinutesEditor } from "../../src/components/deals/minutes-editor";
const root=createRoot(document.getElementById("root")!);
declare global { interface Window { minutesTest: { fail:boolean; requests:string[]; render:(minutes:string)=>void } } }
window.minutesTest={fail:true,requests:[],render(minutes){root.render(<MinutesEditor meetingId="demo" initialMinutes={minutes} initialTranscript="架空の会話" meetingDate="2026-09-21" />)}};
window.fetch=async(input)=>{window.minutesTest.requests.push(String(input));return Response.json({error:"検証用エラー"},{status:window.minutesTest.fail?500:200})};
window.minutesTest.render("## 議事録\n初期の本文");
