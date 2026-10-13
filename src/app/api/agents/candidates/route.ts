import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidAgentToken } from "@/lib/agent-auth";
import { runAsTenant } from "@/lib/tenant-context";
import { BULK_TX_OPTIONS, intakeCandidates } from "@/lib/agent-candidate-ingest";

export const dynamic = "force-dynamic";

// 外部エージェント(Cloud Run)が会社候補を staging(agent_candidates) へ投入する。
// 認証はトークン（Authorization: Bearer <AGENT_INGEST_TOKEN>）。冪等（sourceKey）。
// 件数に比例して DB 往復が増えない書き方は src/lib/agent-candidate-ingest.ts を参照。

const candidateSchema = z.object({
  sourceKey: z.string().min(1),
  companyName: z.string().min(1),
  websiteUrl: z.string().optional(),
  contactFormUrl: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  industry: z.string().optional(),
  address: z.string().optional(),
  evidence: z.any().optional(),
  message: z
    .object({ subject: z.string().optional(), body: z.string().optional() })
    .optional(),
});

const bodySchema = z.object({
  source: z.string().min(1),
  agentRunId: z.string().optional(),
  candidates: z.array(candidateSchema).min(1).max(1000),
});

export async function POST(req: Request) {
  if (!isValidAgentToken(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { source, agentRunId, candidates } = parsed.data;

  try {
    // 外部エージェント（Cloud Run）からの取り込みはログインセッションが無く、
    // Cookie から会社を決められない。営業リストエージェントは Luma の施策なので
    // Luma のコンテキストを明示して実行する。
    // （runAsTenant で包まないと TENANT_STRICT=1 の運用で落ちる）
    const result = await runAsTenant("luma", () =>
      prisma.$transaction(
        (tx) => intakeCandidates(tx, source, agentRunId, candidates),
        BULK_TX_OPTIONS,
      ),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // 握らずに投げると呼び出し側には 500 しか見えず、原因がどこにも残らない
    // （2026-09〜10 に失敗が1か月気付かれなかった）。ログと応答の両方に理由を出す。
    console.error("[agents/candidates] 候補の受け取りに失敗", { source, agentRunId, count: candidates.length }, err);
    return NextResponse.json(
      {
        error: "候補の受け取りに失敗しました",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      },
      { status: 500 },
    );
  }
}
