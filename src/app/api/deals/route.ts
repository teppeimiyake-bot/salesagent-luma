import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DealStatus } from "@prisma/client";
import { probabilityToYomi } from "@/lib/deal-aggregations";
import { buildDealTitle } from "@/lib/deal-title";
import { runAsUserTenant } from "@/lib/tenant-context";

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
  // どちらの会社（Luma / リージー）の商談か。
  // 未指定なら画面で選択中の会社タブに従う（所属が1社だけのユーザーはこちら）。
  tenantId: z.string().uuid().optional(),
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
  const { initialProduct, tenantId: selectedTenantId, ...dealData } = data;

  // 登録先の会社が明示指定された場合は、そのテナントのコンテキストで作成する。
  // runAsUserTenant がログインユーザーの所属を検証し、所属外なら null を返す。
  // 未指定なら従来どおり画面で選択中の会社（Cookie）で作成される。
  if (selectedTenantId) {
    const result = await runAsUserTenant(
      selectedTenantId,
      () => createDeal(dealData, initialProduct),
      { requireWrite: true },
    );
    if (!result) {
      return NextResponse.json(
        { error: "選択された会社に商談を登録する権限がありません" },
        { status: 403 },
      );
    }
    return NextResponse.json({ deal: result });
  }

  const deal = await createDeal(dealData, initialProduct);
  return NextResponse.json({ deal });
}

type CreateDealInput = Omit<z.infer<typeof createSchema>, "initialProduct" | "tenantId">;

async function createDeal(
  dealData: CreateDealInput,
  initialProduct: z.infer<typeof createSchema>["initialProduct"],
) {

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
  return deal;
}
