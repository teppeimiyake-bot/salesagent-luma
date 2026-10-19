import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DealStatusBar } from "../../src/components/deals/deal-status";

type Props = Parameters<typeof DealStatusBar>[0];
type Reply = { method: string; status?: number; body?: { deal?: Partial<Props["deal"]>; status?: string; message?: string }; error?: string };
let props: Props = { users: [], canEdit: true, showMeetingDateTime: true, deal: {
  id: "t02-demo", status: "LEAD", pipelineStage: null, nextAction: null, nextActionAt: null,
  appointmentDate: null, contractDate: null, expectedCloseDate: null, leadSourceId: null,
  leadSource: null, leadSourceMemo: null, owner: null,
  meetingStartAt: "2026-09-24T01:00:00Z", meetingEndAt: "2026-09-24T02:00:00Z", meetUrl: null, meetEventId: null,
} };
const root = createRoot(document.getElementById("root")!);
let key = 0;
const responses: Reply[] = [];
const requests: Array<{ method: string; url: string; body: unknown }> = [];
const unexpected: string[] = [];
function paint() { flushSync(() => root.render(<DealStatusBar key={key} {...props} />)); }
const controller = {
  clipboardFail: false, copied: "",
  configure(next: Partial<Omit<Props, "deal">> & { deal?: Partial<Props["deal"]> }) {
    props = { ...props, ...next, deal: { ...props.deal, ...next.deal } }; key++; paint();
  },
  refresh() { paint(); },
  queue(reply: Reply) { responses.push(reply); },
  updateServer(deal: Partial<Props["deal"]>) { props = { ...props, deal: { ...props.deal, ...deal } }; paint(); },
  snapshot() { return { requests, unexpected, queued: responses.length, copied: controller.copied }; },
};
declare global { interface Window { meetTest: typeof controller } }
window.meetTest = controller;
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  async writeText(text: string) { if (controller.clipboardFail) throw Error("clipboard denied"); controller.copied = text; },
} });
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  if (method === "GET" && url === "/api/pipeline-stages?includeInactive=true") return Response.json({ stages: [] });
  if (method === "GET" && url === "/api/lead-sources?includeInactive=true") return Response.json({ leadSources: [] });
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ method, url, body });
  const reply = responses.shift();
  if (!reply || reply.method !== method || url !== `/api/deals/t02-demo${method === "POST" ? "/meet" : ""}`) {
    unexpected.push(`${method} ${url}`); throw Error("Unregistered request");
  }
  if (reply.error) throw new TypeError(reply.error);
  if (method === "PATCH" && (reply.status ?? 200) === 200) props = { ...props, deal: { ...props.deal, ...body } };
  if (reply.body?.deal) props = { ...props, deal: { ...props.deal, ...reply.body.deal } };
  return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
};
paint();
