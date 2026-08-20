import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { callClaudeJSON } from "@/lib/ai/anthropic";
import { JP_JSON_TEXT_STYLE_RULE } from "@/lib/ai/text-style";

export const maxDuration = 60;

interface PreparationOutput {
  hearing_questions: string[];
  hypotheses: string[];
  talking_points: string[];
  common_concerns: string[];
  recommended_materials: string[];
}

/** 商談前準備：企業情報＋業界＋既存議事録から、ヒアリング項目・仮説・想定論点を生成 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      company: { include: { contacts: true } },
      meetings: { orderBy: { meetingDate: "desc" }, take: 1 },
      products: true,
    },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt || deal.company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }

  const system = `あなたはBtoB営業の事前準備担当。次回の商談に向けて、
- ヒアリング項目（hearing_questions）：必ず聞くべき質問 5〜8個
- 仮説（hypotheses）：顧客の真の課題・潜在ニーズの仮説 3〜5個
- 想定論点（talking_points）：商談で必ず触れるべき切り口 3〜5個
- 想定される顧客の懸念（common_concerns）：刺さりそうなFAQ 3〜5個
- 推奨資料（recommended_materials）：持参/事前送付すべき資料 2〜4個

を生成する。

# 制約
- 抽象禁止。「課題ヒアリング」ではなく「現状の月次離職率／その原因の自己診断／離職コストの試算」のように具体に
- 仮説は「顧客は表向きAと言うが本音はB」の形式で
- 業種・規模に即した内容

JSON厳密出力：
{
  "hearing_questions": ["..."],
  "hypotheses": ["..."],
  "talking_points": ["..."],
  "common_concerns": ["..."],
  "recommended_materials": ["..."]
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
- 企業: ${deal.company.name}（${deal.company.industry ?? "業種不明"}）
- 規模: ${deal.company.employeeCount ?? "?"}名 / 設立${deal.company.establishedYear ?? "?"}年
- 代表者: ${deal.company.ceoName ?? "?"}
- 商談タイトル: ${deal.title}
- 現在のステータス: ${deal.status}
- 提案プロダクト構成（${deal.products.length}件・合計${totalAmount.toLocaleString()}円）:
${productSummary}

# 連絡先
${deal.company.contacts.map((c) => `- ${c.name}（${c.role ?? "役職不明"}${c.isDecisionMaker ? " / 決裁者" : ""}）`).join("\n") || "（未登録）"}

# Webサマリ
${deal.company.websiteSummary ?? "（未取得）"}

# 直近議事録
${deal.meetings[0]?.minutes ?? "（初回商談前）"}`;

  const result = await callClaudeJSON<PreparationOutput>({
    system,
    user: ctx,
    maxTokens: 2500,
    temperature: 0.4,
  });

  if (result) {
    await prisma.aiLog.create({
      data: {
        dealId: id,
        step: "preparation",
        input: { stage: deal.status } as object,
        output: result as unknown as object,
      },
    });
    return NextResponse.json({ preparation: result, fallback: false });
  }

  // フォールバック
  const primaryProduct = deal.products[0]?.productName ?? "提案プロダクト";
  const fallback: PreparationOutput = {
    hearing_questions: [
      `${deal.company.name}における${primaryProduct}の主要KPI（現状の数値）を確認`,
      "意思決定者と稟議プロセス（誰が／いつ／どう決めるか）",
      "予算枠と会計年度のタイミング",
      "競合・代替案との比較状況",
      "導入希望時期と理由",
    ],
    hypotheses: [
      "表向きは情報収集だが本音は社内稟議用の弾を探している",
      "決裁者は商談に出ていないため、稟議用1枚資料が刺さる",
      "価格よりROIで握る方が刺さる",
    ],
    talking_points: [
      "同業界の導入事例（数値インパクト付）",
      "ROI試算（現状コストvs導入後）",
      "決裁プロセスへの伴走（稟議資料作成支援）",
    ],
    common_concerns: [
      "導入に何ヶ月かかるか／既存業務への影響",
      "他社（競合）との違い",
      "失敗事例／チャーン率",
      "サポート体制とSLA",
    ],
    recommended_materials: ["業界別事例集（PDF）", "ROI試算テンプレート（Excel）", "決裁者向け1枚サマリ"],
  };
  return NextResponse.json({ preparation: fallback, fallback: true });
}
