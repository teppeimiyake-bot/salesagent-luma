import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import {
  PAYMENT_TIMINGS,
  CONTRACT_STATUSES,
  INVOICE_SENT_STATUSES,
  PAYMENT_RECV_STATUSES,
  grossFromNet,
} from "@/lib/payments";

const updateSchema = z.object({
  customerName: z.string().min(1).optional(),
  paymentTiming: z.enum(PAYMENT_TIMINGS).optional(),
  contractStatus: z.enum(CONTRACT_STATUSES).optional(),
  invoiceStatus: z.enum(INVOICE_SENT_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_RECV_STATUSES).optional(),
  deliveryDate: z.string().nullable().optional(), // ISO or yyyy-mm-dd or null
  expectedPaymentDate: z.string().nullable().optional(),
  amountNet: z.number().int().nullable().optional(),
  amountGross: z.number().int().nullable().optional(),
  // amountGross を amountNet×1.1 で自動再計算したい時に true
  recomputeGross: z.boolean().optional(),
  note: z.string().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  dealProductId: z.string().uuid().nullable().optional(),
});

function toDate(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  if (s === null || s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * PATCH /api/payments/spot/[id]
 * スポット入金レコードのインライン編集。送付状況・着金状況・各日付・金額。
 * 着金金額(税込) は recomputeGross=true もしくは amountNet 更新時に net×1.1 で再計算可能。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
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

  // 着金金額の税込自動計算ロジック
  let amountGross = d.amountGross;
  if (d.recomputeGross) {
    // 明示再計算：amountNet（リクエスト or 既存値）から算出
    const net =
      d.amountNet !== undefined
        ? d.amountNet
        : (await prisma.invoiceRecord.findUnique({ where: { id }, select: { amountNet: true } }))
            ?.amountNet ?? null;
    amountGross = grossFromNet(net);
  } else if (d.amountNet !== undefined && d.amountGross === undefined) {
    // amountNet だけ変えた場合は税込を自動追従
    amountGross = grossFromNet(d.amountNet);
  }

  const updated = await prisma.invoiceRecord.update({
    where: { id },
    data: {
      ...(d.customerName !== undefined ? { customerName: d.customerName } : {}),
      ...(d.paymentTiming !== undefined ? { paymentTiming: d.paymentTiming } : {}),
      ...(d.contractStatus !== undefined ? { contractStatus: d.contractStatus } : {}),
      ...(d.invoiceStatus !== undefined ? { invoiceStatus: d.invoiceStatus } : {}),
      ...(d.paymentStatus !== undefined ? { paymentStatus: d.paymentStatus } : {}),
      ...(d.deliveryDate !== undefined ? { deliveryDate: toDate(d.deliveryDate) } : {}),
      ...(d.expectedPaymentDate !== undefined
        ? { expectedPaymentDate: toDate(d.expectedPaymentDate) }
        : {}),
      ...(d.amountNet !== undefined ? { amountNet: d.amountNet } : {}),
      ...(amountGross !== undefined ? { amountGross } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.companyId !== undefined ? { companyId: d.companyId } : {}),
      ...(d.dealId !== undefined ? { dealId: d.dealId } : {}),
      ...(d.dealProductId !== undefined ? { dealProductId: d.dealProductId } : {}),
    },
    include: { company: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ record: updated });
}
