import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { callClaude } from "@/lib/ai/anthropic";

const startSchema = z.object({
  dealId: z.string().uuid(),
  level: z.number().int().min(1).max(3),
  scenario: z.string().optional(),
});

const LEVEL_DEFAULTS = {
  1: {
    label: "初級：協力的な顧客",
    scenario:
      "顧客は前向き。情報を素直に出してくれる。導入意欲もあり、質問にも丁寧に答える。価格交渉も穏やか。",
    persona: { name: "山下 直人", role: "経営企画 課長" },
  },
  2: {
    label: "中級：標準的な顧客",
    scenario:
      "顧客は前向きだが慎重。社内稟議のため資料を求める。他社比較もしている。価格交渉あり。決裁者は別。",
    persona: { name: "藤本 真奈", role: "DX推進部 部長" },
  },
  3: {
    label: "上級：難しい顧客",
    scenario:
      "顧客は懐疑的。複数社並行検討中。価格を厳しく追及。決裁者の関心が薄く、現場担当者は前向きでも上が動かない。「持ち帰り」を多用。",
    persona: { name: "黒木 武", role: "経営企画本部 本部長 / 決裁者" },
  },
} as const;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { dealId, level, scenario } = parsed.data;
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { company: { include: { contacts: true } } },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt || deal.company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }

  const conf = LEVEL_DEFAULTS[level as 1 | 2 | 3];

  const session_ = await prisma.roleplaySession.create({
    data: {
      dealId,
      level,
      personaName: conf.persona.name,
      personaRole: conf.persona.role,
      scenario: scenario || conf.scenario,
      log: [
        {
          role: "system",
          content: `${conf.label} / ${conf.persona.name}（${conf.persona.role}）／ シナリオ: ${scenario || conf.scenario}`,
        },
      ],
    },
  });
  return NextResponse.json({ session: session_ });
}

const messageSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1),
});

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { sessionId, message } = parsed.data;
  const sess = await prisma.roleplaySession.findUnique({
    where: { id: sessionId },
    include: { deal: { include: { company: true, products: true } } },
  });
  if (!sess) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const log = (sess.log as Array<{ role: string; content: string }>) ?? [];
  log.push({ role: "user", content: message });

  const levelTone = {
    1: "協力的に、ポジティブな反応を多めに返す。質問には素直に答える。",
    2: "前向きだが慎重。資料・他社比較・社内検討の話題を出す。",
    3: "懐疑的・厳しい。価格を追及、決裁プロセスを盾に持ち帰る、競合の名前を出す。",
  }[sess.level as 1 | 2 | 3];

  const proposedProducts = sess.deal.products
    .map((p) => `${p.productName}${p.planName ? `（${p.planName}）` : ""}`)
    .join(" / ") || "（未指定）";
  const system = `あなたは商談ロープレの**顧客役**を演じる。
- 顧客企業: ${sess.deal.company.name}（${sess.deal.company.industry ?? "—"}）
- 提案プロダクト: ${proposedProducts}
- 想定ペルソナ: ${sess.personaName}（${sess.personaRole}）
- 想定シナリオ: ${sess.scenario}
- レベル ${sess.level}：${levelTone}

リアルな顧客として1〜3文で短く返す。営業を助けない。質問を返したり、決裁プロセスや競合に話題を振ることもある。`;

  const userPrompt = log
    .filter((l) => l.role !== "system")
    .map((l) => `## ${l.role === "user" ? "営業" : "顧客"}\n${l.content}`)
    .join("\n\n");

  const reply = await callClaude({ system, user: userPrompt, maxTokens: 600, temperature: 0.7 });
  const customer =
    reply ??
    `（[AIキー未設定] レベル${sess.level}の顧客役を演じます。.envにGOOGLE_GENERATIVE_AI_API_KEYを入れて再起動してください。）`;
  log.push({ role: "customer", content: customer });

  await prisma.roleplaySession.update({
    where: { id: sessionId },
    data: { log: log as object },
  });
  return NextResponse.json({ reply: customer });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dealId = url.searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  const sessions = await prisma.roleplaySession.findMany({
    where: { dealId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ sessions });
}
