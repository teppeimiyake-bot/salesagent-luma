import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AiChat } from "../../src/components/dashboard/ai-chat";

type MockResponse = { method: "GET" | "POST"; body: unknown; deferred?: boolean };
const root = createRoot(document.getElementById("chat-host")!);
const responses: MockResponse[] = [];
const pending: Array<() => void> = [];
const requests: Array<{ method: string; url: string; body: unknown }> = [];
const unexpectedFetches: string[] = [];
const controller = {
  mount() {
    flushSync(() => root.render(<AiChat scope="deal:scroll-demo" />));
  },
  queue(response: MockResponse) { responses.push(response); },
  resolvePending() {
    const resolve = pending.shift();
    if (!resolve) throw Error("No pending mock response");
    resolve();
  },
  snapshot() {
    return { requests, unexpectedFetches, pendingCount: pending.length, queuedCount: responses.length };
  },
};
declare global { interface Window { chatScrollTest: typeof controller } }
window.chatScrollTest = controller;

// The real component runs against registered local responses only.
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ method, url, body });
  const response = responses.shift();
  const expectedUrl = method === "GET" ? "/api/chat?scope=deal%3Ascroll-demo" : "/api/chat";
  if (!response || response.method !== method || url !== expectedUrl) {
    const error = `Unregistered mock: ${method} ${url}`;
    unexpectedFetches.push(error);
    throw Error(error);
  }
  if (response.deferred) await new Promise<void>((resolve) => pending.push(resolve));
  return Response.json(response.body);
};
