/**
 * 集計専用（PII非出力）。deals 件数 / notionPageId付き / meetingNotes入り / source=notion を数えるだけ。
 *   npx tsx --env-file=.env.production.local scripts/count-meeting-notes.ts
 */
import { prisma } from "../src/lib/db";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("salesagent_luma") && !url.includes("neondb")) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma or neondb");
    process.exit(1);
  }
  const dbLabel = url.includes("neondb") ? "neondb(prod)" : "salesagent_luma(local)";
  const deals = await prisma.deal.findMany({ select: { bant: true } });
  let withPageId = 0;
  let withNotes = 0;
  let sourceNotion = 0;
  for (const d of deals) {
    const b =
      d.bant && typeof d.bant === "object" && !Array.isArray(d.bant)
        ? (d.bant as Record<string, unknown>)
        : null;
    if (typeof b?.notionPageId === "string" && b.notionPageId.length > 0) withPageId++;
    if (typeof b?.meetingNotes === "string" && (b.meetingNotes as string).length > 0) withNotes++;
    if (b?.meetingNotesSource === "notion") sourceNotion++;
  }
  console.log(`DB                          : ${dbLabel}`);
  console.log(`deals total                 : ${deals.length}`);
  console.log(`deals with notionPageId     : ${withPageId}`);
  console.log(`deals with meetingNotes     : ${withNotes}`);
  console.log(`deals meetingNotesSource=notion: ${sourceNotion}`);
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
