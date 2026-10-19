import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import {
  GoogleMeetConfigError,
  GoogleMeetOperationError,
  upsertMeetEvent,
} from "@/lib/google/meet";
import { isMeetAutoRecordEnabled, isMeetFeatureEnabled } from "@/lib/feature-flags";
import { configureDealMeetArtifacts } from "@/lib/meetings/meet-ingest";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 30;

const bodySchema = z
  .object({
    forceRecreate: z.boolean().optional(),
    expectedEventId: z.string().min(1).nullable().optional(),
  })
  .optional();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMeetFeatureEnabled()) return NextResponse.json({ message: "Meet連携は無効です。" }, { status: 404 });
  const raw = await req.text();
  let body;
  try { body = raw.trim() ? JSON.parse(raw) : undefined; }
  catch { return NextResponse.json({ error: "Invalid input" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const me = { permission: await getCurrentPermission() };
  if (!hasPermission(me?.permission, "user")) {
    return await writeForbidden();
  }

  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      company: { select: { name: true, deletedAt: true } },
      owner: { select: { name: true } },
    },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt || deal.company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }
  // T21: 先方Meet・Zoom・対面・未選択の商談では自社Meetを発行しない。
  // 会議種別を変えた後の古い画面から発行・日時同期が走っても、ここで止める。
  if (deal.meetingOwnerType !== "own_meet") {
    return NextResponse.json(
      {
        code: "OWN_MEET_REQUIRED",
        error: "Own Meet required",
        message: "会議種別が「自社発行の Google Meet」の商談だけMeetを発行できます。画面を再読み込みして会議種別を確認してください。",
      },
      { status: 409 },
    );
  }
  if (!deal.meetingStartAt || !deal.meetingEndAt) {
    return NextResponse.json(
      {
        error: "Meeting datetime required",
        message: "商談開始・終了日時を設定してからMeetを発行してください。",
      },
      { status: 400 },
    );
  }
  if (deal.meetingEndAt.getTime() <= deal.meetingStartAt.getTime()) {
    return NextResponse.json(
      {
        error: "Invalid meeting datetime",
        message: "商談終了日時は開始日時より後にしてください。",
      },
      { status: 400 },
    );
  }

  if (parsed.data?.forceRecreate && parsed.data.expectedEventId !== undefined
    && parsed.data.expectedEventId !== deal.meetEventId) {
    return NextResponse.json({ code: "MEET_CHANGED", message: "Meetが更新されています。画面を再読み込みしてから確認してください。" }, { status: 409 });
  }

  try {
    const result = await upsertMeetEvent({
      operationKey: `${deal.tenantId}:${deal.id}`,
      eventId: deal.meetEventId,
      summary: `商談: ${deal.company.name}`,
      description: buildDescription({
        dealTitle: deal.title,
        companyName: deal.company.name,
        ownerName: deal.owner?.name ?? null,
      }),
      startAt: deal.meetingStartAt,
      endAt: deal.meetingEndAt,
      forceRecreate: parsed.data?.forceRecreate,
    });

    const updated = await prisma.deal.update({
      // 発行中に会議種別が自社Meet以外へ変わった場合も P2025 → 409 で再同期を促す（種別は書き換えない）。
      where: { id, deletedAt: null, meetingOwnerType: "own_meet", meetEventId: deal.meetEventId,
        meetingStartAt: deal.meetingStartAt, meetingEndAt: deal.meetingEndAt },
      data: {
        meetUrl: result.meetUrl,
        meetEventId: result.eventId,
        // Reissued URLs must not reuse the old Meet space / artifact state (T16).
        ...(result.eventId !== deal.meetEventId || result.meetUrl && result.meetUrl !== deal.meetUrl ? {
          meetSpaceName: null, meetArtifactConfigStatus: null, meetArtifactConfigError: null,
          meetArtifactConfiguredAt: null, meetArtifactStatus: null, meetArtifactError: null,
          meetArtifactCheckedAt: null, meetArtifactAttempts: 0,
        } : {}),
      },
      select: {
        id: true,
        meetUrl: true,
        meetEventId: true,
        meetingOwnerType: true,
        meetingStartAt: true,
        meetingEndAt: true,
      },
    });

    if (result.status === "pending") {
      return NextResponse.json({ deal: updated, status: "pending", message: "Meetを発行中です。しばらくお待ちください。" }, { status: 202 });
    }
    if (result.status === "failed") {
      return NextResponse.json({ deal: updated, status: "failed", message: "Meetを発行できませんでした。再試行してください。" }, { status: 502 });
    }

    // T16: フラグONのときだけ、Meet側の自動録画・自動文字起こし設定まで踏み込む。
    // ここで失敗してもMeet発行自体は成功しているので200のまま返し、
    // 「設定済み」と誤表示せずに理由と再試行導線を画面に出せるよう本文に載せる。
    if (isMeetAutoRecordEnabled()) {
      const artifactConfig = await configureDealMeetArtifacts(updated.id);
      return NextResponse.json({
        deal: updated,
        artifactConfig: { status: artifactConfig.status, error: artifactConfig.error ?? null },
      });
    }

    return NextResponse.json({ deal: updated });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ code: "MEET_CHANGED", message: "商談日時またはMeetが更新されました。画面を再読み込みして同期してください。" }, { status: 409 });
    }
    if (error instanceof GoogleMeetConfigError) {
      return NextResponse.json(
        {
          error: "Google Meet configuration missing",
          code: "GOOGLE_MEET_CONFIG_MISSING",
          missing: error.missing,
          message: "Meet連携が未設定です。管理者に設定を依頼してください。商談日時は保存されています。",
        },
        { status: 503 },
      );
    }

    const message =
      error instanceof GoogleMeetOperationError
        ? error.message
        : "Meet発行に失敗しました。接続状態を確認して再試行してください。";
    return NextResponse.json(
      {
        error: "Google Meet operation failed",
        code: "GOOGLE_MEET_OPERATION_FAILED",
        message,
      },
      { status: 502 },
    );
  }
}

function buildDescription({
  dealTitle,
  companyName,
  ownerName,
}: {
  dealTitle: string;
  companyName: string;
  ownerName: string | null;
}) {
  return [
    `商談: ${dealTitle}`,
    `会社: ${companyName}`,
    ownerName ? `担当: ${ownerName}` : null,
    "",
    "Generated by Reeasy Luma Platform.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
