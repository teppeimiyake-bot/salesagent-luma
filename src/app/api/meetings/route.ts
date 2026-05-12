import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import crypto from "node:crypto";
import { transcribeFile } from "@/lib/ai/openai";
import {
  putFile,
  writeTempFile,
  cleanupTempFile,
  isBlobEnabled,
  StorageConfigError,
} from "@/lib/storage";
import path from "node:path";

// Vercel Functions のタイムアウト：Hobby plan 60秒、Pro 800秒。
// 録音→Blob upload→Gemini音声処理→DB save の時間を確保。
export const maxDuration = 60;

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
    if (file.size === 0) {
      return NextResponse.json(
        { error: "録音データが空です。マイク権限が許可されているか、録音時間が短すぎないか確認してください。" },
        { status: 400 },
      );
    }
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
    const safeName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());

    // 1) ストレージ保存（local or Blob）
    let recordingUrl: string;
    try {
      ({ url: recordingUrl } = await putFile({
        dir: "recordings",
        filename: safeName,
        buffer: buf,
        contentType: file.type || undefined,
      }));
    } catch (e) {
      const err = e as Error;
      console.error("[api/meetings] putFile failed:", {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
        blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
        onVercel: !!process.env.VERCEL,
      });
      const base =
        e instanceof StorageConfigError ? err.message : "録音ファイルの保存に失敗しました";
      const detail = e instanceof StorageConfigError ? undefined : `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}`;
      return NextResponse.json(
        {
          error: detail ? `${base}（詳細: ${detail}）` : base,
          debug: {
            errorName: err?.name ?? null,
            errorMessage: err?.message ?? null,
            blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
            onVercel: !!process.env.VERCEL,
          },
        },
        { status: 500 },
      );
    }

    // 2) Whisper はローカルファイルパスが必要なので、temp ファイル経由で文字起こし
    //    （Blobモードでは保存先と独立した一時ファイル、Localモードでは保存先そのものを使えるが
    //     実装簡略化のため一律 temp に書く）
    let transcript: string | null = null;
    let tmp: string | null = null;
    try {
      if (isBlobEnabled()) {
        tmp = await writeTempFile(safeName, buf);
        transcript = await transcribeFile(tmp);
      } else {
        // ローカル：保存先パスをそのまま使う
        const localPath = path.join(process.cwd(), "uploads", "recordings", safeName);
        transcript = await transcribeFile(localPath);
      }
    } finally {
      if (tmp) await cleanupTempFile(tmp);
    }

    if (!transcript) {
      transcript = `[文字起こしフォールバック] ファイル ${file.name} を保存しました（AIキー未設定 or 失敗）。商談要約は手動で入力してください。`;
    }

    const meeting = await prisma.meeting.create({
      data: {
        dealId,
        recordingUrl,
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
