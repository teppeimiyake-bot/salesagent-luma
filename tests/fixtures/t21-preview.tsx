import {createRoot} from "react-dom/client";
import {MeetingOwnerSelector} from "../../src/components/deals/meeting-owner-selector";
import {MeetingRecordingRoute} from "../../src/components/deals/meeting-recording-route";
import {recordingRouteFor} from "../../src/lib/meetings/recording-route";
import type {MeetingOwnerType} from "../../src/lib/meetings/meeting-owner";
const root=createRoot(document.getElementById("root")!);
declare global {interface Window{ownerTest:{fail:boolean;render:(owner:MeetingOwnerType,editable?:boolean)=>void}}}
window.ownerTest={fail:true,render(owner,editable=true){root.render(<><MeetingOwnerSelector key={owner+String(editable)} dealId="demo" initialValue={owner} canEdit={editable}/><MeetingRecordingRoute route={recordingRouteFor(owner)}/></>)}};
window.fetch=async()=>{if(window.ownerTest.fail)throw Error("offline");return Response.json({ok:true})};
window.ownerTest.render("own_meet");
