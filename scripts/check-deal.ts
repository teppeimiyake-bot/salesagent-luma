import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const id = "368e1f82-4caa-45a2-acf5-6522e928eee4";
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      meetings: { orderBy: { meetingDate: "desc" } },
    },
  });
  if (!deal) {
    console.log("DEAL NOT FOUND");
    return;
  }

  console.log("\n=== MEETINGS (full AI fields) ===");
  for (const m of deal.meetings) {
    console.log("---meeting id:", m.id, "---");
    console.log("summary:", typeof m.summary, JSON.stringify(m.summary)?.slice(0, 300));
    console.log("issues:", typeof m.issues, JSON.stringify(m.issues)?.slice(0, 600));
    console.log("topSales:", typeof m.topSales, JSON.stringify(m.topSales)?.slice(0, 1200));
    console.log("strategy:", typeof m.strategy, JSON.stringify(m.strategy)?.slice(0, 600));
    console.log("nextActions:", typeof m.nextActions, JSON.stringify(m.nextActions)?.slice(0, 1200));
    console.log("scores:", typeof m.scores, JSON.stringify(m.scores));
    console.log("meta:", typeof m.meta, JSON.stringify(m.meta));
  }

  const documents = await prisma.document.findMany({
    where: { dealId: id },
    select: { id: true, fileUrl: true, name: true, category: true, mimeType: true },
  });
  console.log("\n=== DOCUMENTS ===");
  console.log(JSON.stringify(documents, null, 2));

  // 全Document（global含む、Luma本番でblob URL混入チェック）
  const allDocs = await prisma.document.findMany({
    select: { id: true, name: true, scope: true, fileUrl: true },
  });
  console.log("\n=== ALL DOCUMENTS (sample of URL formats) ===");
  console.log("Total:", allDocs.length);
  const urlFormats: Record<string, number> = {};
  for (const d of allDocs) {
    let format = "other";
    if (d.fileUrl.startsWith("/uploads/")) format = "/uploads/";
    else if (/^https?:\/\/.+\.vercel-storage\.com\//.test(d.fileUrl)) format = "public-blob-url";
    else if (d.fileUrl.includes("/")) format = "blob-pathname";
    urlFormats[format] = (urlFormats[format] ?? 0) + 1;
  }
  console.log(urlFormats);

  // recording URL の formats
  const allMeetings = await prisma.meeting.findMany({
    select: { id: true, recordingUrl: true },
  });
  console.log("\n=== ALL MEETINGS recordingUrl formats ===");
  console.log("Total:", allMeetings.length);
  const recFormats: Record<string, number> = {};
  for (const m of allMeetings) {
    if (!m.recordingUrl) { recFormats.null = (recFormats.null ?? 0) + 1; continue; }
    let format = "other";
    if (m.recordingUrl.startsWith("/uploads/")) format = "/uploads/";
    else if (/^https?:\/\/.+\.vercel-storage\.com\//.test(m.recordingUrl)) format = "public-blob-url";
    else if (m.recordingUrl.includes("/")) format = "blob-pathname";
    recFormats[format] = (recFormats[format] ?? 0) + 1;
  }
  console.log(recFormats);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
