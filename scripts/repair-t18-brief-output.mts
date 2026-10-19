import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prismaUnscoped: prisma } = require("../src/lib/db.ts") as typeof import("../src/lib/db");

const dealId = "16d00000-0000-4000-8000-000000000001";
const [brief, meetings] = await Promise.all([
  prisma.preparationBrief.findFirst({
    where: { dealId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { id: true, hiringInsights: true, painHypotheses: true, proposalStory: true },
  }),
  prisma.meeting.findMany({
    where: { dealId, transcript: { not: null } },
    select: { transcript: true },
  }),
]);

if (!brief) throw new Error("T18 preparation brief not found");
const transcript = meetings.map((meeting) => meeting.transcript ?? "").join("\n");
if (!transcript.includes("面接前辞退が約35パーセントあります")) {
  throw new Error("Expected authoritative transcript evidence was not found");
}

const hypotheses = Array.isArray(brief.painHypotheses)
  ? (brief.painHypotheses as Array<Record<string, unknown>>)
  : [];
let repaired = 0;
const repairedHypotheses = hypotheses.map((hypothesis) => {
  const evidence = typeof hypothesis.evidence === "string" ? hypothesis.evidence : "";
  if (!/明確な回答.*(?:記載|確認)(?:なし|できず)/u.test(evidence)) return hypothesis;
  repaired += 1;
  return {
    ...hypothesis,
    evidence:
      "社内根拠（文字起こし）: 高橋（顧客・人事）『はい。仕事内容が伝わりにくく、面接前辞退が約35パーセントあります。』",
  };
});

const hiringInsights =
  brief.hiringInsights && typeof brief.hiringInsights === "object" && !Array.isArray(brief.hiringInsights)
    ? ({ ...brief.hiringInsights } as Record<string, unknown>)
    : {};
if (typeof hiringInsights.roles === "string" && hiringInsights.roles.includes("商談内で合意")) {
  hiringInsights.roles =
    "文字起こしより、対象は新卒の食品工学系と第二新卒の設備保全経験者。Lumaは前者に研修、後者に裁量と資格支援を訴求する案を提示した（顧客の合意は未確認）。";
  repaired += 1;
}

let proposalStory = brief.proposalStory;
if (proposalStory) {
  const next = proposalStory
    .replace(
      "InstagramおよびYouTubeショートへの展開を前提に",
      "InstagramおよびYouTubeショートへの展開可否・運用条件を確認しながら",
    )
    .replace(
      "InstagramおよびYouTubeへの展開は合意済み",
      "顧客からInstagramおよびYouTubeへの展開可否の質問があり、Lumaは可能と回答済み",
    );
  if (next !== proposalStory) repaired += 1;
  proposalStory = next;
}

if (repaired > 0) {
  await prisma.preparationBrief.update({
    where: { id: brief.id },
    data: {
      painHypotheses: repairedHypotheses as object[],
      hiringInsights: hiringInsights as object,
      proposalStory,
    },
  });
}

console.log(`T18 brief stored-output repair: ${repaired} correction(s)`);
await prisma.$disconnect();
