import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { callClaudeJSON } from "@/lib/ai/anthropic";

export const maxDuration = 30;

interface Suggestion {
  next_action: string;
  next_action_at: string; // YYYY-MM-DD
  reason: string;
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      company: { include: { contacts: true } },
      meetings: { orderBy: { meetingDate: "desc" }, take: 1 },
      tasks: { take: 5, orderBy: { createdAt: "desc" } },
      products: true,
    },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt || deal.company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }

  const system = `あなたはトップ営業の右腕。直近の商談状況から、**次に取るべき1手** を1個生成する。
制約：
- 抽象禁止。「動詞＋目的語＋期限」を含む
- 「フォロー」「検討」「強化」など曖昧な動詞は禁止
- ヨミを上げる方向（決裁者巻き込み・失注リスク潰し・タイミング握り）を優先
- 期限は今日〜2週間以内

JSON厳密：
{
  "next_action": "...",
  "next_action_at": "YYYY-MM-DD",
  "reason": "..."
}`;

  const today = new Date();
  const productSummary = deal.products
    .map(
      (p) =>
        `  - ${p.productName}${p.planName ? `（${p.planName}）` : ""} / ヨミ=${p.yomiStatus ?? "-"} / 金額${p.amount?.toLocaleString() ?? "未設定"}円`,
    )
    .join("\n");
  const totalAmount = deal.products.reduce((s, p) => s + (p.amount ?? 0), 0);
  const ctx = `# 案件
- 企業: ${deal.company.name}（${deal.company.industry ?? "—"}）
- ステータス: ${deal.status}
- プロダクト構成（${deal.products.length}件・合計${totalAmount.toLocaleString()}円）:
${productSummary}
- 現在の Next: ${deal.nextAction ?? "未設定"}
- 連絡先: ${deal.company.contacts.map((c) => `${c.name}(${c.role ?? "?"}${c.isDecisionMaker ? "/決裁者" : ""})`).join(", ") || "なし"}

# 直近議事録要約
${deal.meetings[0]?.minutes ?? "なし"}

# 既存ToDo
${deal.tasks.map((t) => `- ${t.title}`).join("\n") || "なし"}

# 今日
${today.toISOString().slice(0, 10)}

JSONのみ出力。`;

  const result = await callClaudeJSON<Suggestion>({
    system,
    user: ctx,
    maxTokens: 600,
    temperature: 0.4,
  });

  if (result && result.next_action) {
    return NextResponse.json({ suggestion: result, fallback: false });
  }

  // フォールバック
  const days = deal.status === "CLOSING" ? 1 : deal.status === "NEGOTIATION" ? 3 : 5;
  const target = new Date(today.getTime() + days * 86400000);
  const fallback: Suggestion = {
    next_action:
      deal.status === "LEAD"
        ? `初回ヒアリングMTGを${days}日以内にセット（決裁者の出席を依頼）`
        : deal.status === "HEARING"
          ? "次回提案までにROI試算シートと比較表を準備し、決裁者向け1枚資料を作成して送付"
          : deal.status === "PROPOSAL"
            ? "決裁者面談の日程を3スロット提示し48時間以内に確定"
            : deal.status === "NEGOTIATION"
              ? "条件合意のため、契約ドラフトを48時間以内に先方に送付"
              : "契約書最終版の社内承認を取り、本日中に先方へ返送",
    next_action_at: target.toISOString().slice(0, 10),
    reason: "ステータスに応じた標準アクション（AIキー未設定のためフォールバック）",
  };
  return NextResponse.json({ suggestion: fallback, fallback: true });
}
