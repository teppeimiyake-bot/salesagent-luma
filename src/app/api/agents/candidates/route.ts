import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidAgentToken } from "@/lib/agent-auth";
import { runAsTenant } from "@/lib/tenant-context";
import { normalizeName, domainOf } from "@/lib/company-dedup";

export const dynamic = "force-dynamic";

// 外部エージェント(Cloud Run)が会社候補を staging(agent_candidates) へ投入する。
// 認証はトークン（Authorization: Bearer <AGENT_INGEST_TOKEN>）。冪等（sourceKey）。

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

  // 外部エージェント（Cloud Run）からの取り込みはログインセッションが無く、
  // Cookie から会社を決められない。営業リストエージェントは Luma の施策なので
  // Luma のコンテキストを明示して実行する。
  // （runAsTenant で包まないと TENANT_STRICT=1 の運用で落ちる）
  const result = await runAsTenant("luma", () => ingestCandidates(source, agentRunId, candidates));

  return NextResponse.json({ ok: true, ...result });
}

type Candidates = z.infer<typeof bodySchema>["candidates"];

async function ingestCandidates(
  source: string,
  agentRunId: string | null | undefined,
  candidates: Candidates,
) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.create({
      data: { source, agentRunId: agentRunId ?? null },
    });

    // 既存 live 企業との事前突合インデックス（正規化名・ドメイン）
    const live = await tx.company.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, websiteUrl: true },
    });
    const byName = new Map<string, string>();
    const byDomain = new Map<string, string>();
    for (const c of live) {
      const nk = normalizeName(c.name);
      if (nk && !byName.has(nk)) byName.set(nk, c.id);
      const dk = domainOf(c.websiteUrl);
      if (dk && !byDomain.has(dk)) byDomain.set(dk, c.id);
    }

    let created = 0;
    let updated = 0;
    let skippedIngested = 0;
    for (const c of candidates) {
      const dedupeKey = normalizeName(c.companyName);
      const dk = domainOf(c.websiteUrl);
      let matchedCompanyId: string | null = null;
      let matchStatus = "new";
      if (dk && byDomain.has(dk)) {
        matchedCompanyId = byDomain.get(dk)!;
        matchStatus = "domain";
      } else if (dedupeKey && byName.has(dedupeKey)) {
        matchedCompanyId = byName.get(dedupeKey)!;
        matchStatus = "norm";
      }

      const data = {
        runId: run.id,
        companyName: c.companyName,
        dedupeKey,
        websiteUrl: c.websiteUrl ?? null,
        contactFormUrl: c.contactFormUrl ?? null,
        phone: c.phone ?? null,
        email: c.email ?? null,
        industry: c.industry ?? null,
        address: c.address ?? null,
        matchedCompanyId,
        matchStatus,
      };

      const existing = await tx.agentCandidate.findFirst({
        where: { sourceKey: c.sourceKey },
      });
      let candidateId: string;
      if (existing) {
        if (existing.reviewStatus === "ingested") {
          // 取り込み済みは触らない（冪等）
          skippedIngested++;
          continue;
        }
        const up = await tx.agentCandidate.update({
          where: { id: existing.id },
          data,
        });
        candidateId = up.id;
        updated++;
      } else {
        const cr = await tx.agentCandidate.create({
          data: { sourceKey: c.sourceKey, ...data },
        });
        candidateId = cr.id;
        created++;
      }

      // evidence / message は作り直し（冪等）
      if (c.evidence !== undefined) {
        await tx.agentEvidence.deleteMany({ where: { candidateId } });
        await tx.agentEvidence.create({
          data: { candidateId, evidenceJson: c.evidence },
        });
      }
      if (c.message && (c.message.subject || c.message.body)) {
        await tx.agentGeneratedMessage.deleteMany({ where: { candidateId } });
        await tx.agentGeneratedMessage.create({
          data: {
            candidateId,
            subject: c.message.subject ?? null,
            body: c.message.body ?? null,
          },
        });
      }
    }
    return {
      runId: run.id,
      created,
      updated,
      skippedIngested,
      total: candidates.length,
    };
  });
}
