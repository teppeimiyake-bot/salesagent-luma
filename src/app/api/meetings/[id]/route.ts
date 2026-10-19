import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { writeForbidden } from "@/lib/write-guard";

async function authorize(write = false) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (write) {
    const user = { permission: await getCurrentPermission() };
    if (!hasPermission(user?.permission, "user")) return await writeForbidden();
  }
  return null;
}
import { prisma } from "@/lib/db";
import { isAutoBantFeatureEnabled } from "@/lib/feature-flags";
import { scheduleMeetingBantRefresh } from "@/lib/ai/summarize-bant";
import fs from "node:fs/promises";
import { deleteFile } from "@/lib/storage";
import { getRequestTenant } from "@/lib/tenant-context";
import { isUploadManifestKey, removeUploadSessionForKey } from "@/lib/meetings/upload-sessions";
import { transcriptionWorkDir } from "@/lib/meetings/transcription-files";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await authorize(false);
  if (denied) return denied;
  const { id } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { id } });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ meeting });
}

const updateSchema = z.object({
  title: z.string().nullable().optional(),
  minutes: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
  meetingDate: z.string().datetime().optional(),
  bantBudget: z.string().nullable().optional(),
  bantAuthority: z.string().nullable().optional(),
  bantNeed: z.string().nullable().optional(),
  bantTimeline: z.string().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await authorize(true);
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // BANT編集の差分を ai_logs に記録（学習用）
  const before = await prisma.meeting.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const data = parsed.data;
  const meeting = await prisma.meeting.update({
    where: { id },
    data: {
      ...data,
      meetingDate: data.meetingDate ? new Date(data.meetingDate) : undefined,
    },
  });

  if (before) {
    const editKeys = Object.keys(parsed.data).filter(
      (k) => parsed.data[k as keyof typeof parsed.data] !== undefined,
    );
    const beforeView: Record<string, unknown> = {};
    const afterView: Record<string, unknown> = {};
    for (const k of editKeys) {
      beforeView[k] = (before as Record<string, unknown>)[k];
      afterView[k] = (meeting as Record<string, unknown>)[k];
    }
    if (editKeys.some((k) => beforeView[k] !== afterView[k])) {
      await prisma.aiLog.create({
        data: {
          dealId: meeting.dealId,
          step: "bant_user_edit",
          input: { meetingId: id, before: beforeView } as object,
          output: { after: afterView } as object,
          userEdit: parsed.data as object,
        },
      });
    }
  }

  const minutesChanged =
    before &&
    data.minutes !== undefined &&
    (before.minutes ?? "") !== (meeting.minutes ?? "");
  if (minutesChanged && isAutoBantFeatureEnabled()) {
    await scheduleMeetingBantRefresh(meeting.id, "meeting_minutes_saved");
  }

  return NextResponse.json({ meeting });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await authorize(true);
  if (denied) return denied;
  // 全社統合ビューは読み取り専用（削除はテナント境界で拒否されるため、先に理由を返す）
  if ((await getRequestTenant())?.crossTenant) {
    return NextResponse.json({ error: "全社統合ビューでは削除できません。会社を切り替えてください。", code: "CROSS_TENANT_READ_ONLY" }, { status: 409 });
  }
  const { id } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, recordingUrl: true } });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // 記録を先に消す。失敗したらファイルには触れない（記録が残ったまま録音だけ消える状態を作らない）
  await prisma.meeting.delete({ where: { id } });
  await removeMeetingFiles(meeting);
  return NextResponse.json({ ok: true });
}

/**
 * 削除した記録の録音（単一ファイル、または分割アップロードのパート一式）と文字起こしの作業フォルダを消す。
 * 記録の削除は済んでいるため、失敗しても応答は変えずに警告だけ残す（それぞれ独立に試す）。
 * Cloud Run は応答後に CPU を止めるため、投げっぱなしにせず待ってから応答する。
 */
async function removeMeetingFiles({ id, recordingUrl }: { id: string; recordingUrl: string | null }) {
  if (recordingUrl) {
    try {
      // 同じ録音キーを参照する記録が残っていれば消さない（キーは一意に作るため、念のための確認）
      if (await prisma.meeting.count({ where: { recordingUrl } }) === 0) {
        if (isUploadManifestKey(recordingUrl)) await removeUploadSessionForKey(recordingUrl);
        else await deleteFile(recordingUrl);
      }
    } catch (error) {
      console.warn("[api/meetings DELETE] recording cleanup failed:", id, error);
    }
  }
  try {
    await fs.rm(transcriptionWorkDir(id), { recursive: true, force: true });
  } catch (error) {
    console.warn("[api/meetings DELETE] transcription work dir cleanup failed:", id, error);
  }
}
