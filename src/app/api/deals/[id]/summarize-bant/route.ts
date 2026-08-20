import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { callClaudeJSON } from "@/lib/ai/anthropic";
import { getSession, hasPermission } from "@/lib/auth";
import { JP_JSON_TEXT_STYLE_RULE } from "@/lib/ai/text-style";

export const maxDuration = 30;

export interface BantSummary {
  budget: string;
  authority: string;
  need: string;
  timeline: string;
  summary: string; // 全体の総合所感
  confidence: number; // 0-100：情報量の確度
}

/**
 * 全Meetingの議事録/文字起こし＋既存メモを入力に、Deal単位のBANT集約サマリを再生成する。
 * AIキー無しの場合は、各Meetingに既存BANT入力があればそれを連結したフォールバックを返す。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { permission: true },
    });
    if (!hasPermission(me?.permission, "user")) {
      return NextResponse.json({ error: "Forbidden: read-only" }, { status: 403 });
    }

    const deal = await prisma.deal.findUnique({
      where: { id },
      include: {
        company: true,
        meetings: { orderBy: { meetingDate: "asc" } },
        products: true,
      },
    });
    if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (deal.deletedAt || deal.company.deletedAt) {
      return NextResponse.json({ error: "Deleted" }, { status: 410 });
    }

    const meetings = deal.meetings;
    const meetingsBlock = meetings
      .map((m, i) => {
        const ttl = m.title ?? `第${i + 1}回 商談`;
        const date = m.meetingDate.toISOString().slice(0, 10);
        const minutesPart = m.minutes ? `## 議事録\n${m.minutes}` : "";
        const transcriptPart = m.transcript
          ? `## 録画文字起こし（抜粋）\n${m.transcript.slice(0, 2000)}`
          : "";
        const bantPart =
          m.bantBudget || m.bantAuthority || m.bantNeed || m.bantTimeline
            ? `## この回でのBANTメモ\n- B: ${m.bantBudget ?? "—"}\n- A: ${m.bantAuthority ?? "—"}\n- N: ${m.bantNeed ?? "—"}\n- T: ${m.bantTimeline ?? "—"}`
            : "";
        return `# ${ttl}（${date}）\n${minutesPart}\n${transcriptPart}\n${bantPart}`;
      })
      .join("\n\n---\n\n");

    const system = `あなたはトップ営業の右腕。複数回の商談記録から、案件全体のBANT情報を**最新の状態に集約**する。
原則：
- 古い情報より新しい情報を優先（時系列で上書き・追記）
- 「不明」「未確認」は明示的にそう書く（推測で埋めない）
- 抽象NG。金額/役職/動機/時期は**具体的な数字・固有名詞**で
- summary は商談全体の温度感と次に必要なBANT確認事項を1段落で

JSON厳密：
{
  "budget": "予算規模・予算化状況・財源（具体的に）",
  "authority": "決裁者・推進者・反対者（氏名/役職）",
  "need": "顕在/潜在ニーズ・解決したい課題（KPI起点で）",
  "timeline": "意思決定/契約/導入の希望時期（具体的な月）",
  "summary": "案件全体のBANT総合所感と次に取りに行くべき情報（2-3文）",
  "confidence": 0-100（BANT情報の確度。情報量と具体性で評価）
}

${JP_JSON_TEXT_STYLE_RULE}`;

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

# 全商談記録（古い順）
${meetingsBlock || "（まだ商談記録がありません）"}

JSONのみ出力。`;

    const result = await callClaudeJSON<BantSummary>({
      system,
      user: ctx,
      maxTokens: 1500,
      temperature: 0.2,
    });

    let bant: BantSummary;
    let usedFallback = false;
    if (result && typeof result.summary === "string") {
      bant = result;
    } else {
      usedFallback = true;
      // フォールバック：各MeetingのBANTメモを時系列で結合
      const collect = (k: "bantBudget" | "bantAuthority" | "bantNeed" | "bantTimeline") => {
        const xs = meetings
          .filter((m) => m[k])
          .map((m, i) => `（${m.title ?? `第${i + 1}回`}）${m[k]}`);
        return xs.length ? xs.join(" / ") : "未確認";
      };
      bant = {
        budget: collect("bantBudget"),
        authority: collect("bantAuthority"),
        need: collect("bantNeed"),
        timeline: collect("bantTimeline"),
        summary:
          meetings.length === 0
            ? "商談記録がまだありません。初回ヒアリングでBANTを取りに行ってください。"
            : `これまで${meetings.length}回の商談記録あり。AIキー未設定のため自動集約は簡易版です。手動で編集してください。`,
        confidence: meetings.length === 0 ? 0 : 30,
      };
    }

    await prisma.deal.update({
      where: { id },
      data: {
        bant: bant as unknown as object,
        bantUpdatedAt: new Date(),
      },
    });
    await prisma.aiLog.create({
      data: {
        dealId: id,
        step: "bant_summary",
        input: { meetingsCount: meetings.length } as object,
        output: bant as unknown as object,
      },
    });

    return NextResponse.json({ bant, fallback: usedFallback });
  } catch (e) {
    console.error("[summarize-bant] error", e);
    return NextResponse.json(
      {
        error: "internal",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
