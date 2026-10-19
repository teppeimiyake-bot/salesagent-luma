import { createRoot } from "react-dom/client";
import { MeetingRecorder } from "../../src/components/deals/meeting-recorder";
const root = createRoot(document.getElementById("root")!);
declare global { interface Window { recorderTest: { mount: () => void; hide: () => void } } }
window.recorderTest = {
  mount() { root.render(<MeetingRecorder dealId="t03-demo" />); },
  hide() { root.render(null); },
};
window.recorderTest.mount();
