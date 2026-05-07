import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { transcribeFile } from "@/lib/ai/openai";
import { putFile, materializeForRead } from "@/lib/storage";

const createSchema = z.object({
  dealId: z.string().uuid(),
  minutes: z.string().optional(),
  transcript: z.string().optional(),
  meetingDate: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";

  if (ct.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const dealId = form.get("dealId");
    const file = form.get("file") as File | null;
    if (typeof dealId !== "string" || !file) {
      return NextResponse.json({ error: "dealId and file required" }, { status: 400 });
    }

    const ext = file.name.includes(".") ? file.name.split(".").pop() ?? "bin" : "bin";
    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putFile(buf, {
      dir: "recordings",
      ext,
      originalName: file.name,
      contentType: file.type || undefined,
    });

    // 文字起こしは「ローカルファイルパスを必要とする」ため、Blob 時は一時ファイル化
    const { localPath, cleanup } = await materializeForRead(stored.url);
    let transcript: string | null;
    try {
      transcript = await transcribeFile(localPath);
    } finally {
      await cleanup();
    }
    if (!transcript) {
      transcript = `[文字起こしフォールバック] ファイル ${file.name} を保存しました（AIキー未設定）。.env の GOOGLE_GENERATIVE_AI_API_KEY（または OPENAI_API_KEY）を設定し再起動すると自動文字起こしが有効になります。商談要約は手動で入力してください。`;
    }

    const meeting = await prisma.meeting.create({
      data: {
        dealId,
        recordingUrl: stored.url,
        transcript,
      },
    });
    return NextResponse.json({ meeting });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const meeting = await prisma.meeting.create({
    data: {
      dealId: parsed.data.dealId,
      minutes: parsed.data.minutes ?? null,
      transcript: parsed.data.transcript ?? null,
      meetingDate: parsed.data.meetingDate ? new Date(parsed.data.meetingDate) : undefined,
    },
  });
  return NextResponse.json({ meeting });
}
