import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

export async function GET() {
  const companies = await prisma.company.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { deals: true, contacts: true } },
      deals: {
        where: { deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          products: { select: { id: true, productName: true, probability: true, amount: true, yomiStatus: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
      },
    },
  });
  // _count.deals は active を反映しないため、deals 配列の長さで上書き
  const result = companies.map((c) => ({
    ...c,
    _count: { ...c._count, deals: c.deals.length },
  }));
  return NextResponse.json({ companies: result });
}

const createSchema = z.object({
  name: z.string().min(1),
  industry: z.string().optional(),
  // リージー版運用：HP URL は必須
  websiteUrl: z.string().url("HP URL は http:// または https:// で始まる正しいURLを指定してください"),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const company = await prisma.company.create({ data: parsed.data });
  return NextResponse.json({ company });
}
