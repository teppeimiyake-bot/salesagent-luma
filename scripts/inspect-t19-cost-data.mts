import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prismaUnscoped: prisma } = require("../src/lib/db.ts") as typeof import("../src/lib/db");

const dealIds = [
  "16d00000-0000-4000-8000-000000000001",
  "06146d16-0fea-43df-be6d-36f3775b7002",
  "21d00000-0000-4000-8000-000000000003",
];

function usageNodes(value: unknown, path = "$"): Array<{ path: string; usage: unknown }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => usageNodes(item, `${path}[${index}]`));
  }
  const record = value as Record<string, unknown>;
  const here = "usage" in record ? [{ path: `${path}.usage`, usage: record.usage }] : [];
  return here.concat(
    Object.entries(record).flatMap(([key, item]) =>
      key === "usage" ? [] : usageNodes(item, `${path}.${key}`),
    ),
  );
}

function jsonChars(value: unknown): number {
  return JSON.stringify(value ?? null).length;
}

const [deals, logs, quotes, documents] = await Promise.all([
  prisma.deal.findMany({
    where: { id: { in: dealIds } },
    select: {
      id: true,
      title: true,
      bant: true,
      preparationBriefs: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          status: true,
          model: true,
          createdAt: true,
          industrySummary: true,
          hiringInsights: true,
          painHypotheses: true,
          proposalStory: true,
          talkingPoints: true,
          sources: true,
        },
      },
      meetings: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          sourceType: true,
          durationSec: true,
          transcript: true,
          minutes: true,
          processingStatus: true,
          processingStartedAt: true,
          processingCompletedAt: true,
          createdAt: true,
          meta: true,
        },
      },
    },
  }),
  prisma.aiLog.findMany({
    where: { dealId: { in: dealIds } },
    orderBy: { createdAt: "desc" },
    select: { id: true, dealId: true, step: true, input: true, output: true, createdAt: true },
  }),
  prisma.quote.findMany({
    where: { dealId: { in: dealIds } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      dealId: true,
      status: true,
      quoteNumber: true,
      createdAt: true,
      updatedAt: true,
      finalizedAt: true,
      documentId: true,
      lines: { select: { name: true, detail: true, qty: true, unitPrice: true } },
    },
  }),
  prisma.document.findMany({
    where: { dealId: { in: dealIds }, category: "quote" },
    orderBy: { createdAt: "desc" },
    select: { id: true, dealId: true, fileSize: true, createdAt: true },
  }),
]);

const result = {
  inspectedAt: new Date().toISOString(),
  deals: deals.map((deal) => ({
    id: deal.id,
    title: deal.title,
    bantChars: jsonChars(deal.bant),
    briefs: deal.preparationBriefs.map((brief) => ({
      id: brief.id,
      status: brief.status,
      model: brief.model,
      createdAt: brief.createdAt,
      outputChars: jsonChars({
        industrySummary: brief.industrySummary,
        hiringInsights: brief.hiringInsights,
        painHypotheses: brief.painHypotheses,
        proposalStory: brief.proposalStory,
        talkingPoints: brief.talkingPoints,
        sources: brief.sources,
      }),
    })),
    meetings: deal.meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      sourceType: meeting.sourceType,
      durationSec: meeting.durationSec,
      transcriptChars: meeting.transcript?.length ?? 0,
      minutesChars: meeting.minutes?.length ?? 0,
      processingStatus: meeting.processingStatus,
      processingStartedAt: meeting.processingStartedAt,
      processingCompletedAt: meeting.processingCompletedAt,
      processingElapsedMs:
        meeting.processingStartedAt && meeting.processingCompletedAt
          ? meeting.processingCompletedAt.getTime() - meeting.processingStartedAt.getTime()
          : null,
      createdAt: meeting.createdAt,
      meta: meeting.meta,
      usage: usageNodes(meeting.meta),
    })),
  })),
  logs: logs.map((log) => ({
    id: log.id,
    dealId: log.dealId,
    step: log.step,
    createdAt: log.createdAt,
    inputChars: jsonChars(log.input),
    outputChars: jsonChars(log.output),
    usage: usageNodes(log.output),
  })),
  quotes: quotes.map((quote) => ({
    id: quote.id,
    dealId: quote.dealId,
    status: quote.status,
    quoteNumber: quote.quoteNumber,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    finalizedAt: quote.finalizedAt,
    document: documents.find((document) => document.id === quote.documentId) ?? null,
    inputChars: jsonChars(quote.lines),
    lineCount: quote.lines.length,
  })),
};

console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
