import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const updateSchema = z.object({
  customerName: z.string().min(1).optional(),
  initialFee: z.number().int().nullable().optional(),
  monthlyFee: z.number().int().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
});

function toDate(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  if (s === null || s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * PATCH /api/payments/recurring/[id]
 * 定期契約ヘッダ（初期費用/月額/契約期間/顧客名）のインライン編集。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Phase 9：入金管理は admin 限定
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const updated = await prisma.recurringBilling.update({
    where: { id },
    data: {
      ...(d.customerName !== undefined ? { customerName: d.customerName } : {}),
      ...(d.initialFee !== undefined ? { initialFee: d.initialFee } : {}),
      ...(d.monthlyFee !== undefined ? { monthlyFee: d.monthlyFee } : {}),
      ...(d.startDate !== undefined ? { startDate: toDate(d.startDate) } : {}),
      ...(d.endDate !== undefined ? { endDate: toDate(d.endDate) } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.companyId !== undefined ? { companyId: d.companyId } : {}),
    },
    include: {
      company: { select: { id: true, name: true } },
      periods: { orderBy: { yearMonth: "asc" } },
    },
  });
  return NextResponse.json({ billing: updated });
}
