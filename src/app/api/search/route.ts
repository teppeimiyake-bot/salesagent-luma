import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { matchCompaniesByName } from "@/lib/company-search";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ companies: [], deals: [] });

  // 社名は素の contains だと表記ゆれ（全半角・法人格の有無/位置・記号）で落ちるので、
  // 正規化した社名リストとの突き合わせで企業IDを先に確定させる。
  // 企業マスタは数百件規模なので id/name だけの全件取得で十分間に合う。
  const nameIndex = await prisma.company.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true },
  });
  const matchedIds = matchCompaniesByName(nameIndex, q, 10).map((c) => c.id);

  const [companies, deals] = await Promise.all([
    prisma.company.findMany({
      where: {
        deletedAt: null,
        OR: [
          ...(matchedIds.length > 0 ? [{ id: { in: matchedIds } }] : []),
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
          // 表記ゆれ吸収で引き当てた企業の商談も拾う
          ...(matchedIds.length > 0 ? [{ companyId: { in: matchedIds } }] : []),
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

  // 社名マッチの並び（前方一致優先）を検索結果の並びにも反映する
  const rank = new Map(matchedIds.map((id, i) => [id, i]));
  companies.sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  return NextResponse.json({ companies, deals });
}
