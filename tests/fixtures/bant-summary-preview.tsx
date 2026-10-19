import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { BantSummary } from "../../src/components/deals/bant-summary";

type Props = Parameters<typeof BantSummary>[0];
type MockResponse = {
  method: "PATCH" | "POST";
  url: string;
  status?: number;
  body?: unknown;
  rawText?: string;
  error?: string;
  deferred?: boolean;
};

const root = createRoot(document.getElementById("root")!);
let props: Props = {
  dealId: "demo-deal-a",
  initial: null,
  bantUpdatedAt: null,
  meetingsCount: 2,
  canEdit: true,
};
const responses: MockResponse[] = [];
const requests: Array<{ url: string; method: string; body: unknown }> = [];
const unexpectedFetches: string[] = [];
const pendingResponses: Array<() => void> = [];
let refreshCount = 0;

function render(next: Partial<Props>) {
  props = { ...props, ...next };
  flushSync(() => root.render(<BantSummary {...props} />));
}

const controller = {
  render,
  refresh() {
    // Server-prop delivery is controlled separately by render(), as with an RSC refresh.
    refreshCount += 1;
  },
  queue(response: MockResponse) {
    responses.push(response);
  },
  resolvePending() {
    const resolve = pendingResponses.shift();
    if (!resolve) throw new Error("No deferred mock response is pending");
    resolve();
  },
  snapshot() {
    return {
      requests,
      unexpectedFetches,
      refreshCount,
      pendingCount: pendingResponses.length,
      queuedCount: responses.length,
    };
  },
};

declare global {
  interface Window {
    bantTest: typeof controller;
  }
}

window.bantTest = controller;
// No native-fetch fallback is retained. Every request must match an explicitly queued mock.
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const rawBody = init?.body;
  let body: unknown = rawBody ?? null;
  if (typeof rawBody === "string") {
    try { body = JSON.parse(rawBody); } catch { /* Keep unexpected bodies observable. */ }
  }
  requests.push({ url, method, body });
  const response = responses.shift();
  if (!response || response.url !== url || response.method !== method) {
    const description = `Unregistered offline request: ${method} ${url}`;
    unexpectedFetches.push(description);
    throw new Error(description);
  }
  if (response.deferred) {
    await new Promise<void>((resolve) => pendingResponses.push(resolve));
  }
  if (response.error) throw new TypeError(response.error);
  return new Response(response.rawText ?? JSON.stringify(response.body ?? {}), {
    status: response.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
};

render({});
