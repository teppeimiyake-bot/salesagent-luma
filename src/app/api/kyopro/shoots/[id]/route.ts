import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";
import { KYOPRO_ROLES } from "@/lib/kyopro";

const roleEnum = z.enum(KYOPRO_ROLES as [string, ...string[]]);

const updateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  kind: z.enum(["SHOOT", "SETUP"]).optional(),
  clientId: z.string().uuid().optional(),
  venueId: z.string().uuid().nullish(),
  status: z.enum(["PLANNED", "CONFIRMED", "DONE", "CANCELLED"]).optional(),
  requiredCounts: z.record(roleEnum, z.number().int().min(0).max(50)).nullish(),
  startTime: z.string().max(10).nullish(),
  endTime: z.string().max(10).nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * GET /api/kyopro/shoots/[id]
 * 撮影会詳細（スライドオーバー）に必要な材料を一括で返す。
 *   - 撮影会本体とアサイン
 *   - 人材マスタ（対応職種での絞り込み用）とレート（金額の初期値・レンジ警告用）
 *   - 同じ日に別会場へ入っている人（重複警告用）
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("viewer");
  if (!g.ok) return g.response;
  const { id } = await params;

  const shoot = await prisma.kyoproShoot.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true, colorHex: true } },
      venue: { select: { id: true, name: true } },
      assignments: {
        include: { staff: { select: { id: true, name: true } } },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!shoot) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [staff, rates, sameDay] = await Promise.all([
    prisma.kyoproStaff.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, roles: true, trainee: true, payOverrides: true },
    }),
    prisma.kyoproRate.findMany({ orderBy: [{ role: "asc" }, { effectiveFrom: "asc" }] }),
    // 同日・別撮影会のアサイン（掛け持ちは可能だが、うっかり二重に入れないよう警告する）
    prisma.kyoproAssignment.findMany({
      where: {
        status: { not: "CANCELLED" },
        shoot: { date: shoot.date, id: { not: shoot.id }, status: { not: "CANCELLED" } },
      },
      select: {
        staffId: true,
        role: true,
        shoot: { select: { id: true, client: { select: { name: true } }, venue: { select: { name: true } } } },
      },
    }),
  ]);

  return NextResponse.json({
    shoot: {
      id: shoot.id,
      date: shoot.date.toISOString().slice(0, 10),
      kind: shoot.kind,
      status: shoot.status,
      clientName: shoot.client.name,
      clientColor: shoot.client.colorHex,
      venueName: shoot.venue?.name ?? null,
      startTime: shoot.startTime,
      endTime: shoot.endTime,
      note: shoot.note,
      requiredCounts: shoot.requiredCounts ?? {},
    },
    assignments: shoot.assignments.map((a) => ({
      id: a.id,
      role: a.role,
      staffId: a.staffId,
      staffName: a.staff.name,
      status: a.status,
      billAmount: a.billAmount,
      payAmount: a.payAmount,
      trainee: a.trainee,
      cleanup: a.cleanup,
      cleanupBillAmount: a.cleanupBillAmount,
      cleanupPayAmount: a.cleanupPayAmount,
      adjustAmount: a.adjustAmount,
      note: a.note,
    })),
    staff,
    rates,
    sameDay: sameDay.map((a) => ({
      staffId: a.staffId,
      where: `${a.shoot.client.name}${a.shoot.venue ? `／${a.shoot.venue.name}` : ""}`,
    })),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const shoot = await prisma.kyoproShoot.update({
    where: { id },
    data: {
      ...(d.date ? { date: new Date(`${d.date}T00:00:00.000Z`) } : {}),
      ...(d.kind ? { kind: d.kind } : {}),
      ...(d.clientId ? { clientId: d.clientId } : {}),
      ...(d.venueId !== undefined ? { venueId: d.venueId } : {}),
      ...(d.status ? { status: d.status } : {}),
      ...(d.requiredCounts !== undefined ? { requiredCounts: d.requiredCounts ?? undefined } : {}),
      ...(d.startTime !== undefined ? { startTime: d.startTime } : {}),
      ...(d.endTime !== undefined ? { endTime: d.endTime } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
    },
    include: { client: true, venue: true },
  });
  return NextResponse.json({ shoot });
}

/**
 * DELETE /api/kyopro/shoots/[id]
 * アサインが入っている撮影会は消さない（請求・支払の履歴になるため）。
 * 中止になった場合は status=CANCELLED に落として集計から外す。
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const { id } = await params;
  const assignments = await prisma.kyoproAssignment.count({ where: { shootId: id } });
  if (assignments > 0) {
    const shoot = await prisma.kyoproShoot.update({ where: { id }, data: { status: "CANCELLED" } });
    return NextResponse.json({ shoot, mode: "cancelled", assignments });
  }
  await prisma.kyoproShoot.delete({ where: { id } });
  return NextResponse.json({ ok: true, mode: "deleted" });
}
