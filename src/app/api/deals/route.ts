import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DealStatus } from "@prisma/client";
import { probabilityToYomi } from "@/lib/deal-aggregations";
import { buildDealTitle } from "@/lib/deal-title";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ownerUserId = url.searchParams.get("ownerUserId");
  const companyId = url.searchParams.get("companyId");
  const deals = await prisma.deal.findMany({
    where: {
      ...(ownerUserId
        ? {
            OR: [
              { ownerUserId },
              { products: { some: { ownerUserId } } },
            ],
          }
        : {}),
      ...(companyId ? { companyId } : {}),
      deletedAt: null,
      company: { deletedAt: null },
    },
    orderBy: [{ nextActionAt: "asc" }, { updatedAt: "desc" }],
    include: {
      company: true,
      owner: { select: { id: true, name: true, avatarColor: true } },
      leadSource: { select: { id: true, name: true } },
      products: {
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          product: { select: { id: true, name: true } },
        },
        orderBy: [{ amount: "desc" }, { createdAt: "asc" }],
      },
      _count: { select: { meetings: true, tasks: true } },
    },
  });
  return NextResponse.json({ deals });
}

const createSchema = z.object({
  companyId: z.string().uuid(),
  // title はサーバー側で「商談日 + 会社名 + 担当者名」から自動生成する。
  // クライアントから送られても無視（フォールバックとしてのみ参照）。
  title: z.string().min(1).optional(),
  status: z.nativeEnum(DealStatus).optional(),
  pipelineStage: z.string().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  // リージー版：必須運用だが互換のため optional
  leadSourceId: z.string().uuid().nullable().optional(),
  // リード獲得メモ（自由記述、複数行可）
  leadSourceMemo: z.string().nullable().optional(),
  // 初回商談日（タイトル自動生成にも使う。Notion「商談日」プロパティと双方向同期）
  appointmentDate: z.string().datetime().nullable().optional(),
  nextAction: z.string().optional(),
  nextActionAt: z.string().datetime().optional(),
  expectedCloseDate: z.string().datetime().optional(),
  contractDate: z.string().datetime().optional(),
  // 初期 DealProduct 1件（任意・新ダイアログでは未使用）
  initialProduct: z
    .object({
      productId: z.string().uuid().nullable().optional(),
      productName: z.string().min(1),
      planName: z.string().nullable().optional(),
      probability: z.number().int().min(0).max(100).optional(),
      amount: z.number().int().nullable().optional(),
      yomiStatus: z.string().nullable().optional(),
      ownerUserId: z.string().uuid().nullable().optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const { initialProduct, ...dealData } = data;

  // タイトルを「商談日 + 会社名 + 担当者名」で自動生成する。
  // 会社名・担当者名は最新のマスタから引く（クライアント送信値に依存しない）。
  const [company, owner] = await Promise.all([
    prisma.company.findUnique({
      where: { id: dealData.companyId },
      select: { name: true },
    }),
    dealData.ownerUserId
      ? prisma.user.findUnique({
          where: { id: dealData.ownerUserId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);
  const generatedTitle = buildDealTitle({
    appointmentDate: dealData.appointmentDate ?? null,
    companyName: company?.name,
    ownerName: owner?.name,
  });
  // 生成できなければクライアント送信 title、それも無ければ会社名 → "新規商談"
  const finalTitle =
    generatedTitle ?? dealData.title ?? company?.name ?? "新規商談";

  const deal = await prisma.deal.create({
    data: {
      ...dealData,
      title: finalTitle,
      nextActionAt: dealData.nextActionAt ? new Date(dealData.nextActionAt) : undefined,
      appointmentDate: dealData.appointmentDate ? new Date(dealData.appointmentDate) : undefined,
      expectedCloseDate: dealData.expectedCloseDate ? new Date(dealData.expectedCloseDate) : undefined,
      contractDate: dealData.contractDate ? new Date(dealData.contractDate) : undefined,
      ...(initialProduct
        ? {
            products: {
              create: {
                productId: initialProduct.productId ?? null,
                productName: initialProduct.productName,
                planName: initialProduct.planName ?? null,
                probability: initialProduct.probability ?? 20,
                amount: initialProduct.amount ?? null,
                yomiStatus:
                  initialProduct.yomiStatus ??
                  (initialProduct.probability != null
                    ? probabilityToYomi(initialProduct.probability)
                    : null),
                ownerUserId: initialProduct.ownerUserId ?? dealData.ownerUserId ?? null,
              },
            },
          }
        : {}),
    },
    include: {
      company: true,
      owner: true,
      products: true,
    },
  });
  return NextResponse.json({ deal });
}
