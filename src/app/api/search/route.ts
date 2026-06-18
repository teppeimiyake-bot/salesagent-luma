import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ companies: [], deals: [] });

  const [companies, deals] = await Promise.all([
    prisma.company.findMany({
      where: {
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { industry: { contains: q, mode: "insensitive" } },
          { ceoName: { contains: q, mode: "insensitive" } },
          { address: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        industry: true,
        logoUrl: true,
        logoColor: true,
        // 注：_countはソフト削除を反映しないが、検索プレビュー用途なので許容
        _count: { select: { deals: true } },
      },
      take: 10,
    }),
    prisma.deal.findMany({
      where: {
        deletedAt: null,
        company: { deletedAt: null },
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { nextAction: { contains: q, mode: "insensitive" } },
          { company: { name: { contains: q, mode: "insensitive" } } },
          // 担当者（自社オーナー）名で検索：漢字フルネーム・姓のみ（部分一致）・カタカナ読みのいずれでもヒット。
          // Notion取込の商談はタイトルが会社名のみで担当者名を含まないため、owner を直接見る必要がある。
          { owner: { name: { contains: q, mode: "insensitive" } } },
          { owner: { nameKana: { contains: q, mode: "insensitive" } } },
          {
            products: {
              some: {
                OR: [
                  { productName: { contains: q, mode: "insensitive" } },
                  { planName: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          },
        ],
      },
      include: {
        company: { select: { id: true, name: true, logoUrl: true, logoColor: true } },
        owner: { select: { id: true, name: true, avatarColor: true } },
        products: {
          select: { id: true, productName: true, probability: true, amount: true, yomiStatus: true },
        },
      },
      take: 10,
    }),
  ]);

  return NextResponse.json({ companies, deals });
}
