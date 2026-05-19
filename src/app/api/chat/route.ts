import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { callClaude } from "@/lib/ai/anthropic";

const sendSchema = z.object({
  scope: z.string().default("global"),
  content: z.string().min(1),
});

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") ?? "global";
  const messages = await prisma.chatMessage.findMany({
    where: { userId: session.userId, scope },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return NextResponse.json({ messages });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { scope, content } = parsed.data;

  await prisma.chatMessage.create({
    data: { userId: session.userId, scope, role: "user", content },
  });

  // コンテキスト：dealスコープなら案件情報、globalなら自分の今日のサマリ
  let contextBlock = "";
  if (scope.startsWith("deal:")) {
    const dealId = scope.slice(5);
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: {
        company: { include: { contacts: true } },
        meetings: { orderBy: { meetingDate: "desc" }, take: 1 },
        tasks: true,
        products: true,
      },
    });
    if (deal) {
      const productLines = deal.products
        .map(
          (p) =>
            `  - ${p.productName}${p.planName ? `（${p.planName}）` : ""}: ヨミ=${p.yomiStatus ?? "-"}, 金額${p.amount ?? "未設定"}`,
        )
        .join("\n");
      const totalAmount = deal.products.reduce((s, p) => s + (p.amount ?? 0), 0);
      contextBlock = `# 案件コンテキスト
企業: ${deal.company.name}
タイトル: ${deal.title}
ステータス: ${deal.status}
プロダクト構成（${deal.products.length}件）:
${productLines}
提案金額合計: ${totalAmount}円
次回アクション: ${deal.nextAction ?? "未設定"}
最新議事録要約: ${deal.meetings[0]?.minutes ?? "なし"}`;
    }
  } else {
    const myDeals = await prisma.deal.findMany({
      where: {
        OR: [
          { ownerUserId: session.userId },
          { products: { some: { ownerUserId: session.userId } } },
        ],
        deletedAt: null,
        company: { deletedAt: null },
      },
      include: { company: true, products: true },
      take: 10,
    });
    contextBlock = `# あなたの担当案件\n${myDeals
      .map((d) => {
        const products = d.products
          .map((p) => `${p.productName}(${p.yomiStatus ?? "-"})`)
          .join("/");
        return `- ${d.company.name} / [${products}]（次: ${d.nextAction ?? "未"})`;
      })
      .join("\n")}`;
  }

  const history = await prisma.chatMessage.findMany({
    where: { userId: session.userId, scope },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  const recent = history.slice(-10);

  const system = `あなたは営業担当の右腕として伴走するAIエージェント。
役割：受注確度を上げるために、ユーザーの質問に**即実行可能なアクション**で答える。
原則：
- 抽象論禁止（「関係構築」「フォローアップ」だけ→NG）
- 「動詞＋目的語＋期限」で具体策を出す
- 受注を取りにいく姿勢で、決裁者巻き込み・失注リスク潰し・タイミング握りを優先

${contextBlock}`;

  const userMsg = recent
    .map((m) => `## ${m.role === "user" ? "営業" : "AI"}\n${m.content}`)
    .join("\n\n");

  const reply = await callClaude({ system, user: userMsg, maxTokens: 1500, temperature: 0.5 });
  const aiResponse =
    reply ??
    `【AIキー未設定モード】\n質問: 「${content}」\n\nAIキーが未設定のため、本格的な回答はできません。\n.envに GOOGLE_GENERATIVE_AI_API_KEY を入れて再起動すれば、案件コンテキストを踏まえた具体的アドバイスが得られます。`;

  await prisma.chatMessage.create({
    data: { userId: session.userId, scope, role: "assistant", content: aiResponse },
  });

  return NextResponse.json({ reply: aiResponse });
}
