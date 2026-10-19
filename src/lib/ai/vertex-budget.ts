import { randomUUID } from "node:crypto";
import { VertexError, VERTEX_BUDGET_JPY, VERTEX_RESERVATION_JPY } from "./vertex-policy";

export type VertexAttempt = {
  id: string; feature: string; model: string; reservedJpy: number; startedAt: string;
  status: "reserved" | "success" | "error"; usage?: Record<string, unknown>; errorCode?: string;
  // Search requests only: queries the model ran (Gemini 3 grounding is billed per query). null = unknown.
  searchQueries?: number | null;
};
export type VertexLedger = { version: 1; scope: "luma-platform-development"; limitJpy: typeof VERTEX_BUDGET_JPY; attempts: VertexAttempt[] };
export interface VertexLedgerStore {
  read(): Promise<{ generation: string; ledger: VertexLedger }>;
  // Returns false when the write was not applied: a GCS generation conflict (412) or a rate-limited write
  // (429, after a short wait). The caller re-reads and retries, and stays idempotent by attempt id in case a
  // write reported as not applied did land. Other failures throw (fail closed).
  write(generation: string, ledger: VertexLedger): Promise<boolean>;
}
export function validateLedger(ledger: VertexLedger) {
  if (ledger?.version !== 1 || ledger.scope !== "luma-platform-development" || ledger.limitJpy !== VERTEX_BUDGET_JPY
    || !Array.isArray(ledger.attempts) || ledger.attempts.length > VERTEX_BUDGET_JPY / VERTEX_RESERVATION_JPY
    || ledger.attempts.some(a => !a.id || ![VERTEX_RESERVATION_JPY, 100].includes(a.reservedJpy) || !["reserved", "success", "error"].includes(a.status))
    || new Set(ledger.attempts.map(a => a.id)).size !== ledger.attempts.length) {
    throw new VertexError("ledger_invalid", "AI利用記録を確認できないため、呼び出しを停止しました。");
  }
}
export async function reserveVertexAttempt(store: VertexLedgerStore, feature: string, model: string, search = false) {
  const attempt: VertexAttempt = { id: randomUUID(), feature, model, reservedJpy: search ? 100 : VERTEX_RESERVATION_JPY, startedAt: new Date().toISOString(), status: "reserved" };
  for (let retry = 0; retry < 8; retry++) {
    const { generation, ledger } = await store.read();
    validateLedger(ledger);
    // A write reported as not applied may still have landed; never record the same reservation twice.
    if (ledger.attempts.some(a => a.id === attempt.id)) return attempt.id;
    if (ledger.attempts.reduce((n, a) => n + a.reservedJpy, 0) + attempt.reservedJpy > VERTEX_BUDGET_JPY) {
      throw new VertexError("budget", "AI検証用の利用枠に達しました。追加実行前に利用状況を確認してください。");
    }
    if (await store.write(generation, { ...ledger, attempts: [...ledger.attempts, attempt] })) return attempt.id;
  }
  throw new VertexError("ledger_busy", "AI利用枠を確保できませんでした。少し待ってから再実行してください。");
}
export async function finishVertexAttempt(store: VertexLedgerStore, id: string, result: Pick<VertexAttempt, "status" | "usage" | "errorCode" | "searchQueries">) {
  for (let retry = 0; retry < 8; retry++) {
    const { generation, ledger } = await store.read();
    validateLedger(ledger);
    const attempt = ledger.attempts.find(a => a.id === id);
    if (!attempt) throw new VertexError("ledger_missing", "AI利用記録を更新できませんでした。");
    // Never release reservations, even on timeout, missing usage, or process death.
    if (await store.write(generation, { ...ledger, attempts: ledger.attempts.map(a => a.id === id ? { ...a, ...result } : a) })) return;
  }
  throw new VertexError("ledger_busy", "AI利用記録を更新できませんでした。");
}
