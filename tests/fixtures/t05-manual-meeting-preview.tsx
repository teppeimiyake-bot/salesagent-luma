import { createRoot } from "react-dom/client";
import type { ComponentProps } from "react";
import { MeetingHistory } from "../../src/components/deals/meeting-history";

type Meeting = ComponentProps<typeof MeetingHistory>["meetings"][number];
const root = createRoot(document.getElementById("root")!);
const analysisError = "AIサービスとの接続に失敗しました（429）。認証・利用枠を確認してください。";
const analysisMeeting: Meeting = {
  id: "analysis-demo", title: "第6回 商談", meetingDate: "2026-09-23T00:00:00.000Z",
  minutes: null, minutesJson: null, transcript: "保存済みの架空商談本文。予算は80万円です。", recordingUrl: "/saved-recording",
  processingStatus: "transcribed", processingError: null, durationSec: 120, audioSizeBytes: 1024,
  processingStartedAt: null, processingCompletedAt: null, summary: null,
  bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: null,
};

declare global {
  interface Window {
    manualMeetingTest: {
      mode: "http" | "network" | "malformed" | "missing" | "deferred" | "success";
      requests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
      resolve: (() => void) | null;
    };
    meetingAnalysisTest: {
      mode: "http429" | "http500" | "network" | "malformed" | "inflight" | "deferred" | "success";
      statusMode: "success" | "network" | "http";
      requests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
      resolve: (() => void) | null;
      meeting: Meeting;
      status: Record<string, unknown>;
      show: (changes?: Partial<Meeting>) => void;
      refresh: (changes?: Partial<Meeting>) => void;
    };
  }
}

function snapshot(meeting: Meeting) {
  return { ...meeting, hasTranscript: !!meeting.transcript?.trim(), hasMinutes: !!meeting.minutes,
    hasSummary: !!meeting.summary, hasRecording: !!meeting.recordingUrl };
}

window.meetingAnalysisTest = {
  mode: "http429", statusMode: "success", requests: [], resolve: null,
  meeting: analysisMeeting, status: snapshot(analysisMeeting),
  show(changes = {}) {
    this.meeting = { ...analysisMeeting, ...changes };
    this.status = snapshot(this.meeting);
    root.render(<MeetingHistory key="analysis" dealId="analysis-deal" meetings={[this.meeting]} />);
  },
  refresh(changes = {}) {
    this.meeting = { ...this.meeting, ...changes };
    this.status = snapshot(this.meeting);
    root.render(<MeetingHistory key="analysis" dealId="analysis-deal" meetings={[this.meeting]} />);
  },
};

window.manualMeetingTest = { mode: "http", requests: [], resolve: null };
window.fetch = async (input, options) => {
  if (String(input).startsWith("/api/meetings/analysis-demo")) {
    const state = window.meetingAnalysisTest;
    state.requests.push({ url: String(input), method: options?.method ?? "GET", body: JSON.parse(String(options?.body ?? "{}")) });
    if (String(input).endsWith("/status")) {
      if (options?.method === "POST") throw new Error("Existing transcript must not be transcribed again");
      if (state.statusMode === "network") throw new TypeError("status connection failed");
      if (state.statusMode === "http") return new Response("unavailable", { status: 503 });
      return Response.json({ meeting: state.status });
    }
    if (state.mode === "deferred") await new Promise<void>((resolve) => { state.resolve = resolve; });
    if (state.mode === "network") throw new TypeError("analysis connection failed");
    if (state.mode === "malformed") return new Response("unavailable", { status: 502 });
    if (state.mode === "http429" || state.mode === "http500") {
      state.status = { ...state.status, processingStatus: "error", processingError: analysisError };
      return Response.json({ error: analysisError }, { status: state.mode === "http429" ? 429 : 500 });
    }
    if (state.mode === "inflight") {
      state.status = { ...state.status, processingStatus: "analyzing", processingError: null };
      return Response.json({ error: "処理中です。", processingStatus: "analyzing" }, { status: 409 });
    }
    state.status = { ...state.status, processingStatus: "completed", processingError: null, hasSummary: true, hasMinutes: true };
    return Response.json({ ok: true, meetingId: "analysis-demo" });
  }
  const state = window.manualMeetingTest;
  state.requests.push({ url: String(input), method: options?.method ?? "GET", body: JSON.parse(String(options?.body ?? "{}")) });
  if (state.mode === "network") throw new TypeError("test connection failed");
  if (state.mode === "http") return Response.json({ error: "記録を追加できません（検証用）" }, { status: 400 });
  if (state.mode === "malformed") return new Response("error", { status: 500 });
  if (state.mode === "missing") return Response.json({});
  if (state.mode === "deferred") await new Promise<void>((resolve) => { state.resolve = resolve; });
  return Response.json({ meeting: { id: "manual-demo" } });
};

root.render(<MeetingHistory dealId="manual-demo-deal" meetings={[]} />);
