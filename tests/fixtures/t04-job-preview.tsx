import { createRoot } from "react-dom/client";
import type { ComponentProps } from "react";
import { MeetingHistory } from "../../src/components/deals/meeting-history";

type Meeting = ComponentProps<typeof MeetingHistory>["meetings"][number];
const root = createRoot(document.getElementById("root")!);

const base: Meeting = {
  id: "job-a", title: "第2回 商談", meetingDate: "2026-09-24T00:00:00.000Z",
  minutes: null, minutesJson: null, transcript: null, recordingUrl: "/uploads/recordings/long.webm",
  processingStatus: "transcribing", processingError: null, durationSec: 3600, audioSizeBytes: 14 * 1024 * 1024,
  processingStartedAt: null, processingCompletedAt: null, summary: null,
  bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: null, meta: null,
};

type Snapshot = Record<string, unknown>;
declare global {
  interface Window {
    jobTest: {
      continueMode: "deferred" | "forbidden" | "progress";
      requests: Array<{ url: string; method: string }>;
      statuses: Record<string, Snapshot>;
      show: (meetings: Array<Partial<Meeting> & { id: string }>, statuses: Record<string, Snapshot>) => void;
      count: (fragment: string, method?: string) => number;
    };
  }
}

window.jobTest = {
  continueMode: "deferred",
  requests: [],
  statuses: {},
  show(meetings, statuses) {
    this.statuses = statuses;
    root.render(<MeetingHistory dealId="job-deal" meetings={meetings.map(meeting => ({ ...base, ...meeting }))} />);
  },
  count(fragment, method) {
    return this.requests.filter(request => request.url.includes(fragment) && (!method || request.method === method)).length;
  },
};

window.fetch = async (input, options) => {
  const url = String(input);
  const method = options?.method ?? "GET";
  const state = window.jobTest;
  state.requests.push({ url, method });
  const id = url.split("/")[3];
  if (url.endsWith("/status")) return Response.json({ meeting: state.statuses[id] });
  if (url.endsWith("/transcription") && method === "POST") {
    if (state.continueMode === "deferred") return new Promise<Response>(() => {});
    if (state.continueMode === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
    // 長い記録の分析（原文抜粋の抽出）なら抽出の区間、そうでなければ文字起こしの区間を1つ進める。
    const current = state.statuses[id] as { transcription?: { completed: number; total: number }; analysis?: { completed: number; total: number } };
    const next = current.analysis
      ? { ...current, analysis: { ...current.analysis, completed: current.analysis.completed + 1 } }
      : { ...current, transcription: { ...current.transcription!, completed: current.transcription!.completed + 1 } };
    state.statuses[id] = next;
    return Response.json({ outcome: "progressed", meeting: next });
  }
  if (url.endsWith("/recording")) return new Response(new Uint8Array(0), { headers: { "content-type": "audio/mpeg" } });
  if (url.endsWith("/analyze") && method === "POST") {
    return Response.json({ accepted: true, mode: "long_analysis", processingStatus: "analyzing", chunks: 6 }, { status: 202 });
  }
  throw new Error(`unexpected request ${method} ${url}`);
};
