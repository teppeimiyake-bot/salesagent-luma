import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DealStatus } from "@prisma/client";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { syncDealAppointmentDateToNotion } from "@/lib/notion-sync";
import { buildDealTitle } from "@/lib/deal-title";
import { isEndBeforeStart, meetingScheduledAtFromStart } from "@/lib/meeting-datetime";
import { BANT_KEYS, type BantKey } from "@/lib/ai/bant-definitions";
import { repairUtf8Mojibake } from "@/components/deals/bant-summary-utils";
import { MEETING_OWNER_TYPES } from "@/lib/meetings/meeting-owner";
import { reconcileBantFromMeetings } from "@/lib/ai/bant-reconciliation";
import { writeForbidden } from "@/lib/write-guard";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      company: { include: { contacts: true } },
      owner: { select: { id: true, name: true, avatarColor: true, email: true } },
      leadSource: { select: { id: true, name: true } },
      products: {
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          product: {
            select: {
              id: true,
              name: true,
              plans: {
                where: { active: true },
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                select: { id: true, name: true, basePrice: true },
              },
            },
          },
        },
        orderBy: [{ amount: "desc" }, { createdAt: "asc" }],
      },
      meetings: { orderBy: { meetingDate: "desc" } },
      tasks: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt || deal.company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }
  return NextResponse.json({
    deal: { ...deal, bant: reconcileBantFromMeetings(deal.bant, deal.meetings) },
  });
}

const bantSchema = z
  .object({
    budget: z.string().optional(),
    authority: z.string().optional(),
    need: z.string().optional(),
    timeline: z.string().optional(),
    summary: z.string().optional(),
    confidence: z.number().int().min(0).max(100).optional(),
  })
  .passthrough()
  .partial();

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.nativeEnum(DealStatus).optional(),
  pipelineStage: z.string().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
  appointmentDate: z.string().datetime().nullable().optional(),
  meetingScheduledAt: z.string().datetime().nullable().optional(),
  // 商談日時（T01）。任意項目なので、これらを送らない既存クライアントは従来どおり動く
  meetingStartAt: z.string().datetime().nullable().optional(),
  meetingEndAt: z.string().datetime().nullable().optional(),
  meetingOwnerType: z.enum(MEETING_OWNER_TYPES).optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  contractDate: z.string().datetime().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  leadSourceId: z.string().uuid().nullable().optional(),
  leadSourceMemo: z.string().nullable().optional(),
  bant: bantSchema.optional(),
});

function readBantPatchString(bant: Record<string, unknown>, key: BantKey): string {
  const direct = bant[key];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const value = (direct as Record<string, unknown>).value;
    if (typeof value === "string") return value;
  }
  const items = bant.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    const item = (items as Record<string, unknown>)[key];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const value = (item as Record<string, unknown>).value;
      if (typeof value === "string") return value;
    }
  }
  return "";
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const data = parsed.data;
  // 商談の更新は、項目に関係なく操作中の会社で利用者以上（閲覧のみ・全社統合ビューは更新できない）。
  // 403 は requireWriter と同じ日本語の理由（全社統合ビューなら会社の切り替えの案内）。
  if (!hasPermission(await getCurrentPermission(), "user")) {
    return await writeForbidden();
  }

  // Validate the final range, including the unchanged half of a partial PATCH.
  const changesMeeting = data.meetingStartAt !== undefined || data.meetingEndAt !== undefined;
  let meetingVersion: Date | undefined;
  let meetingScheduleChanged = false;
  if (changesMeeting || data.meetingOwnerType !== undefined) {
    if (!hasPermission(await getCurrentPermission(), "user")) {
      return await writeForbidden();
    }
    const current = await prisma.deal.findUnique({
      where: { id },
      select: { meetingStartAt: true, meetingEndAt: true, updatedAt: true, deletedAt: true,
        company: { select: { deletedAt: true } } },
    });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (current.deletedAt || current.company.deletedAt) {
      return NextResponse.json({ error: "Deleted" }, { status: 410 });
    }
    const nextStart = data.meetingStartAt === undefined ? current.meetingStartAt?.toISOString() : data.meetingStartAt;
    const nextEnd = data.meetingEndAt === undefined ? current.meetingEndAt?.toISOString() : data.meetingEndAt;
    if (changesMeeting && nextEnd && !nextStart) {
      return NextResponse.json({ message: "開始日時を先に入力してください。" }, { status: 400 });
    }
    if (changesMeeting && isEndBeforeStart(nextStart ?? null, nextEnd ?? null)) {
      return NextResponse.json({ message: "終了日時は開始日時以降にしてください。" }, { status: 400 });
    }
    meetingVersion = current.updatedAt;
    // 同じ日時の再送（表記ゆれ含む）は変更扱いにしない
    const sameInstant = (next: string | null | undefined, previous: Date | null) =>
      (next ? Date.parse(next) : null) === (previous ? previous.getTime() : null);
    meetingScheduleChanged = changesMeeting
      && (!sameInstant(nextStart, current.meetingStartAt) || !sameInstant(nextEnd, current.meetingEndAt));
  }

  let bantPatch: { bant?: object; bantUpdatedAt?: Date } = {};
  let bantUserEditLog:
    | {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        changedKeys: BantKey[];
      }
    | null = null;
  if (data.bant) {
    const existing = await prisma.deal.findUnique({
      where: { id },
      select: { bant: true },
    });
    const existingBant =
      existing?.bant && typeof existing.bant === "object" && !Array.isArray(existing.bant)
        ? (existing.bant as Record<string, unknown>)
        : {};
    const incomingBant = data.bant as Record<string, unknown>;
    const manualFields =
      existingBant.manualFields &&
      typeof existingBant.manualFields === "object" &&
      !Array.isArray(existingBant.manualFields)
        ? { ...(existingBant.manualFields as Record<string, unknown>) }
        : {};
    const changedKeys = BANT_KEYS.filter(
      (key) =>
        Object.prototype.hasOwnProperty.call(incomingBant, key) &&
        typeof incomingBant[key] === "string" &&
        readBantPatchString(existingBant, key) !== incomingBant[key],
    );
    for (const key of changedKeys) manualFields[key] = true;

    const existingItems =
      existingBant.items && typeof existingBant.items === "object" && !Array.isArray(existingBant.items)
        ? { ...(existingBant.items as Record<string, unknown>) }
        : {};
    const incomingItems =
      incomingBant.items && typeof incomingBant.items === "object" && !Array.isArray(incomingBant.items)
        ? (incomingBant.items as Record<string, unknown>)
        : {};
    const mergedItems: Record<string, unknown> = { ...existingItems, ...incomingItems };
    for (const key of changedKeys) {
      mergedItems[key] = {
        value: incomingBant[key],
        // Editing the text is not an explicit review of its certainty.
        status: "unknown",
        source_meeting_id: "",
        quote: "User edited this BANT field manually.",
      };
    }

    // 既存BANTが空オブジェクトのときスプレッドで index signature が落ち、
    // merged.summary の参照が型エラーになるため、明示的に注釈する（挙動は変えない）。
    const merged: Record<string, unknown> = {
      ...existingBant,
      ...incomingBant,
      items: mergedItems,
      manualFields,
      updatedBy: "manual",
    };
    if (typeof merged.summary === "string") {
      merged.summary = repairUtf8Mojibake(merged.summary);
    }
    if (changedKeys.length > 0) {
      bantUserEditLog = {
        before: Object.fromEntries(BANT_KEYS.map((key) => [key, readBantPatchString(existingBant, key)])),
        after: Object.fromEntries(BANT_KEYS.map((key) => [key, readBantPatchString(merged, key)])),
        changedKeys,
      };
    }
    bantPatch = { bant: merged, bantUpdatedAt: new Date() };
  }

  const { bant: _bantIgnored, ...rest } = data;
  void _bantIgnored;

  // 商談日時（T01）を保存したときは、日付部分を meetingScheduledAt（商談予定日）にも同期する。
  // ms管理タブは meetingScheduledAt を date-only で表示・編集しているため、
  // 商談詳細で日時を入れると ms管理側にも同じ日付が出る（逆方向は従来どおり ms管理が上書き）。
  // meetingScheduledAt が同一リクエストで明示指定された場合は、そちらを尊重して同期しない。
  let meetingScheduledSync: Date | null | undefined = undefined;
  if (data.meetingStartAt !== undefined && data.meetingScheduledAt === undefined) {
    meetingScheduledSync = meetingScheduledAtFromStart(data.meetingStartAt);
  }

  // 商談日(appointmentDate)または担当者(ownerUserId)が変更された場合、
  // タイトル「商談日 + 会社名 + 担当者名」を自動で再生成して追従させる。
  // - クライアントから明示的に title が送られた場合はそれを優先（手動編集を尊重）
  // - 既存の Deal を読み、変更後の値でタイトルを組み立てる
  let titlePatch: { title?: string } = {};
  const appointmentChanged = data.appointmentDate !== undefined;
  const ownerChanged = data.ownerUserId !== undefined;
  if (data.title === undefined && (appointmentChanged || ownerChanged)) {
    const current = await prisma.deal.findUnique({
      where: { id },
      select: {
        appointmentDate: true,
        ownerUserId: true,
        company: { select: { name: true } },
        owner: { select: { name: true } },
      },
    });
    if (current) {
      // 変更後の appointmentDate（未指定なら現状維持）
      const nextAppointment = appointmentChanged
        ? data.appointmentDate
          ? new Date(data.appointmentDate)
          : null
        : current.appointmentDate;
      // 変更後の owner 名（owner 変更時のみ引き直し）
      let nextOwnerName: string | null = current.owner?.name ?? null;
      if (ownerChanged) {
        nextOwnerName = data.ownerUserId
          ? (
              await prisma.user.findUnique({
                where: { id: data.ownerUserId },
                select: { name: true },
              })
            )?.name ?? null
          : null;
      }
      const newTitle = buildDealTitle({
        appointmentDate: nextAppointment,
        companyName: current.company?.name,
        ownerName: nextOwnerName,
      });
      if (newTitle) titlePatch = { title: newTitle };
    }
  }

  const deal = await prisma.deal.update({
    where: { id, ...(meetingVersion ? { updatedAt: meetingVersion } : {}) },
    data: {
      ...rest,
      ...titlePatch,
      nextActionAt:
        data.nextActionAt === undefined
          ? undefined
          : data.nextActionAt
            ? new Date(data.nextActionAt)
            : null,
      appointmentDate:
        data.appointmentDate === undefined
          ? undefined
          : data.appointmentDate
            ? new Date(data.appointmentDate)
            : null,
      meetingScheduledAt:
        data.meetingScheduledAt === undefined
          ? meetingScheduledSync
          : data.meetingScheduledAt
            ? new Date(data.meetingScheduledAt)
            : null,
      meetingStartAt:
        data.meetingStartAt === undefined
          ? undefined
          : data.meetingStartAt
            ? new Date(data.meetingStartAt)
            : null,
      meetingEndAt:
        data.meetingEndAt === undefined
          ? undefined
          : data.meetingEndAt
            ? new Date(data.meetingEndAt)
            : null,
      expectedCloseDate:
        data.expectedCloseDate === undefined
          ? undefined
          : data.expectedCloseDate
            ? new Date(data.expectedCloseDate)
            : null,
      contractDate:
        data.contractDate === undefined
          ? undefined
          : data.contractDate
            ? new Date(data.contractDate)
            : null,
      ...bantPatch,
      // T16: 日時を組み直したら、前の予定で進んだ成果物取得の状態を戻し、次の会議をcron・手動取得で取り直せるようにする。
      // （Meet URL を変えたときの meet/route.ts のリセットと同じ項目。自動録画の設定状態はスペース単位なので残す）
      ...(meetingScheduleChanged ? {
        meetArtifactStatus: null, meetArtifactError: null, meetArtifactCheckedAt: null, meetArtifactAttempts: 0,
      } : {}),
    },
  }).catch((error: unknown) => {
    // A concurrent edit must not invalidate the range checked above.
    if (meetingVersion && error && typeof error === "object" && "code" in error && error.code === "P2025") return null;
    throw error;
  });
  if (!deal) {
    return NextResponse.json({ message: "別の更新がありました。最新の日時を確認して再試行してください。" }, { status: 409 });
  }

  if (bantUserEditLog) {
    await prisma.aiLog.create({
      data: {
        dealId: id,
        step: "bant_user_edit",
        input: { before: bantUserEditLog.before, changedKeys: bantUserEditLog.changedKeys } as object,
        output: { after: bantUserEditLog.after } as object,
        userEdit: data.bant as object,
      },
    });
  }

  // 初回商談日（appointmentDate）が変更された場合、Notionの「商談日」プロパティに反映
  // - DBは保存済み。Notion失敗してもAPI本体は止めない
  // - notionSync: "ok" | "skipped" | "failed" を返す
  let notionSync: "ok" | "skipped" | "failed" = "skipped";
  if (data.appointmentDate !== undefined) {
    const dateForNotion = data.appointmentDate ? new Date(data.appointmentDate) : null;
    const result = await syncDealAppointmentDateToNotion(id, dateForNotion);
    if (result.ok) {
      notionSync = result.skipped ? "skipped" : "ok";
    } else {
      notionSync = "failed";
    }
  }

  return NextResponse.json({ deal, notionSync });
}

/**
 * DELETE
 *  - デフォルト：ソフト削除（user/admin）
 *  - ?permanent=true：物理削除（admin only、関連は onDelete: Cascade で消える）
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const permanent = url.searchParams.get("permanent") === "true";
  const perm = await getCurrentPermission();

  if (permanent) {
    if (!hasPermission(perm, "admin")) {
      return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
    }
    await prisma.deal.delete({ where: { id } });
    return NextResponse.json({ ok: true, mode: "permanent" });
  }

  if (!hasPermission(perm, "user")) {
    return await writeForbidden();
  }
  await prisma.deal.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true, mode: "soft" });
}
