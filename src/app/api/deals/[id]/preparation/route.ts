import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { callClaudeJSON } from "@/lib/ai/anthropic";
import { JP_JSON_TEXT_STYLE_RULE } from "@/lib/ai/text-style";
import { formatLumaContextForPrompt, getLumaContextText } from "@/lib/ai/luma-context";
import { isPreparationV2Enabled } from "@/lib/feature-flags";
import {
  PREPARATION_DISCLAIMER,
  canCreatePreparationBrief,
  runPreparationBrief,
  type PreparationHiringInsights,
  type PreparationPainHypothesis,
  type PreparationSource,
} from "@/lib/ai/preparation";
import { getTokyoDayRange } from "@/lib/preparation-cron";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 300;

interface PreparationOutput {
  hearing_questions: string[];
  hypotheses: string[];
  talking_points: string[];
  common_concerns: string[];
  recommended_materials: string[];
}

type PreparationBriefRow = {
  id: string;
  status: string;
  error: string | null;
  industrySummary: string | null;
  hiringInsights: unknown;
  painHypotheses: unknown;
  proposalStory: string | null;
  talkingPoints: unknown;
  sources: unknown;
  model: string | null;
  createdAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// Same threshold and message as PREPARATION_STALE_AFTER_MS / PREPARATION_INTERRUPTED_MESSAGE
// in src/lib/ai/preparation.ts. Kept local because route harnesses mock that module narrowly.
const STALE_BRIEF_AFTER_MS = 10 * 60 * 1000;
const INTERRUPTED_BRIEF_MESSAGE = "AI処理が中断されました（開始から10分以上完了していません）。再実行してください。";
const IN_PROGRESS_STATUSES = ["pending", "researching", "generating"];

function isInterruptedBrief(row: Pick<PreparationBriefRow, "status" | "createdAt">, now: number): boolean {
  return IN_PROGRESS_STATUSES.includes(row.status) && now - row.createdAt.getTime() > STALE_BRIEF_AFTER_MS;
}

function serializeBrief(row: PreparationBriefRow | null, now = Date.now()) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    error: row.error,
    // Judged with the server clock so the panel never compares its own clock
    // with created_at. True only while the recovery write has not landed.
    interrupted: isInterruptedBrief(row, now),
    industry_summary: row.industrySummary,
    hiring_insights: isRecord(row.hiringInsights)
      ? (row.hiringInsights as PreparationHiringInsights)
      : null,
    pain_hypotheses: asArray<PreparationPainHypothesis>(row.painHypotheses),
    proposal_story: row.proposalStory,
    talking_points: row.talkingPoints,
    vertex_grounding: isRecord(row.talkingPoints) ? row.talkingPoints.vertexGrounding ?? null : null,
    sources: asArray<PreparationSource>(row.sources),
    model: row.model,
    created_at: row.createdAt.toISOString(),
    disclaimer: PREPARATION_DISCLAIMER,
  };
}

/**
 * Saved briefs are for the whole team (T09: 他のメンバーからも見られる), so GET
 * accepts viewers like the rest of the deal page. Creating a brief and every
 * other write, including the interrupted-brief recovery, needs user or above.
 */
async function requirePermission(required: "viewer" | "user") {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  // 操作中の会社での権限（全社共通の User.permission ではない）。取れない（ユーザーが無い等）ときは閲覧も断る。
  const permission = await getCurrentPermission();
  if (!permission || !hasPermission(permission, required)) {
    // 書き込み（利用者以上）の 403 は requireWriter と同じ日本語の理由（全社統合ビューなら会社の切り替えの案内）
    return { error: required === "user" ? await writeForbidden() : NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return {
    session,
    permission,
    canWrite: hasPermission(permission, "user"),
    isAdmin: hasPermission(permission, "admin"),
  };
}

async function ensureActiveDeal(id: string) {
  const deal = await prisma.deal.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, company: { select: { deletedAt: true } } },
  });
  if (!deal) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (deal.deletedAt || deal.company.deletedAt) {
    return { error: NextResponse.json({ error: "Deleted" }, { status: 410 }) };
  }
  return { deal };
}

/**
 * A request timeout or CPU throttling on Cloud Run can leave a brief in progress
 * forever, which blocks the panel and counts toward the daily limit. Treat such
 * a brief as interrupted before reading or creating briefs.
 */
async function recoverInterruptedBriefs(dealId: string, now: number) {
  try {
    await prisma.preparationBrief.updateMany({
      where: {
        dealId,
        status: { in: IN_PROGRESS_STATUSES },
        createdAt: { lt: new Date(now - STALE_BRIEF_AFTER_MS) },
      },
      data: { status: "error", error: INTERRUPTED_BRIEF_MESSAGE },
    });
  } catch (e) {
    // e.g. the read-only all-company view. serializeBrief still reports such a
    // brief as interrupted, so the panel stops waiting for it.
    console.warn("[preparation-v2] interrupted brief recovery skipped", e instanceof Error ? e.message : e);
  }
}

function runInlineForPreparationV2(): boolean {
  return process.env.NODE_ENV !== "production" || !process.env.VERCEL;
}

async function legacyPost(id: string) {
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

  const system = `
あなたはBtoB営業の事前準備担当です。次回商談に向けて、以下をJSONだけで生成してください。
- hearing_questions: 必ず聞くべき質問を5個
- hypotheses: 顧客課題や潜在ニーズの仮説を3個
- talking_points: 商談で触れるべき論点を3個
- common_concerns: 想定される懸念やFAQを3個
- recommended_materials: 持参または事前送付すべき資料を2から3個

制約:
- 抽象論は禁止し、現状の情報に即して具体化する
- 仮説は断定しない
- JSONのみを返す

${JP_JSON_TEXT_STYLE_RULE}
`.trim();

  const productSummary = deal.products
    .map((p) =>
      [
        p.productName,
        p.planName ? `plan=${p.planName}` : "",
        p.yomiStatus ? `yomi=${p.yomiStatus}` : "",
        p.amount != null ? `amount=${p.amount}` : "",
      ]
        .filter(Boolean)
        .join(" / "),
    )
    .join("\n");
  const totalAmount = deal.products.reduce((s, p) => s + (p.amount ?? 0), 0);
  const lumaContext = await getLumaContextText({ dealProducts: deal.products });
  const ctx = `
# 案件
- 企業: ${deal.company.name}
- 業界: ${deal.company.industry ?? "不明"}
- 規模: ${deal.company.employeeCount ?? "不明"}名 / 設立${deal.company.establishedYear ?? "不明"}年
- 代表者: ${deal.company.ceoName ?? "不明"}
- 商談タイトル: ${deal.title}
- 現在のステータス: ${deal.status}
- 提案プロダクト: ${deal.products.length}件 / 合計${totalAmount.toLocaleString("ja-JP")}円
${productSummary || "未設定"}

# 連絡先
${deal.company.contacts
  .map((c) => `- ${c.name} / ${c.role ?? "役職不明"}${c.isDecisionMaker ? " / 決裁者" : ""}`)
  .join("\n") || "未登録"}

# Webサマリー
${deal.company.websiteSummary ?? "未取得"}

# 直近議事録
${deal.meetings[0]?.minutes ?? "初回商談前"}
`.trim();

  const result = await callClaudeJSON<PreparationOutput>({
    system,
    cacheableSystem: formatLumaContextForPrompt(lumaContext),
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

  const primaryProduct = deal.products[0]?.productName ?? "提案プロダクト";
  const fallback: PreparationOutput = {
    hearing_questions: [
      `${deal.company.name}における${primaryProduct}の主要KPIを確認する`,
      "意思決定者と稟議プロセスを確認する",
      "予算確保と導入希望時期を確認する",
      "既存施策や競合比較で重視している点を確認する",
      "導入後に社内で説明すべき成果指標を確認する",
    ],
    hypotheses: [
      "採用広報や営業資料で、候補者や顧客に伝わる情報の整理に課題がある可能性",
      "決裁者が商談に同席していないため、社内説明用の根拠資料が必要になる可能性",
      "価格そのものより、成果イメージとROIを説明できることが重要になる可能性",
    ],
    talking_points: [
      "同業界の導入事例や成果指標",
      "現状コストと導入後の運用負荷の比較",
      "稟議に使える資料や説明材料の用意",
    ],
    common_concerns: [
      "導入までの期間と既存業務への影響",
      "他社施策との違い",
      "失敗事例や期待値調整",
    ],
    recommended_materials: ["業界別事例集", "ROI試算テンプレート", "決裁者向けサマリー"],
  };
  return NextResponse.json({ preparation: fallback, fallback: true });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isPreparationV2Enabled()) {
    return NextResponse.json({ error: "Preparation V2 disabled" }, { status: 404 });
  }

  const { id } = await params;
  const auth = await requirePermission("viewer");
  if (auth.error) return auth.error;

  const active = await ensureActiveDeal(id);
  if (active.error) return active.error;
  const now = Date.now();
  // Viewers only read. serializeBrief still flags a stale brief with the server
  // clock, so their panel stops waiting without the recovery write.
  if (auth.canWrite) await recoverInterruptedBriefs(id, now);

  const url = new URL(req.url);
  const history = url.searchParams.get("history") === "1";
  if (history) {
    const rows = await prisma.preparationBrief.findMany({
      where: { dealId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return NextResponse.json({ briefs: rows.map((row) => serializeBrief(row, now)) });
  }

  const row = await prisma.preparationBrief.findFirst({
    where: { dealId: id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ brief: serializeBrief(row, now), can_create: auth.canWrite });
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requirePermission("user");
  if (auth.error) return auth.error;
  if (!isPreparationV2Enabled()) {
    return legacyPost(id);
  }

  const active = await ensureActiveDeal(id);
  if (active.error) return active.error;
  await recoverInterruptedBriefs(id, Date.now());

  // QG26-04: two tabs pressing at once must not create two briefs (and call Vertex twice).
  // The daily-limit count, the in-progress check and the creation run under one
  // transaction-scoped advisory lock per deal (same pattern as the quote finalize),
  // so the second request waits for the first creation and then sees its brief.
  // Interrupted briefs were turned into errors above, so they do not block.
  const today = getTokyoDayRange(new Date(), 0);
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preparation-brief:${id}`}))`;
    const createdToday = await tx.preparationBrief.count({
      where: {
        dealId: id,
        createdAt: { gte: today.start, lt: today.end },
        status: { not: "error" },
      },
    });
    if (!canCreatePreparationBrief({ createdToday, isAdmin: auth.isAdmin, limit: 3 })) {
      return { kind: "limited" as const };
    }
    const running = await tx.preparationBrief.findFirst({
      where: {
        dealId: id,
        status: { in: IN_PROGRESS_STATUSES },
        createdAt: { gte: new Date(Date.now() - STALE_BRIEF_AFTER_MS) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (running) return { kind: "running" as const, row: running };
    const created = await tx.preparationBrief.create({
      data: {
        dealId: id,
        status: "pending",
        createdById: auth.session.userId,
      },
    });
    return { kind: "created" as const, row: created };
  });
  if (claim.kind === "limited") {
    return NextResponse.json(
      { error: "Too many preparation briefs", message: "事前準備ブリーフの再生成は1案件1日3回までです。" },
      { status: 429 },
    );
  }
  if (claim.kind === "running") {
    // Already being generated (e.g. by another tab): answer with that brief instead of
    // starting a second generation. The panel follows it by polling as usual.
    return NextResponse.json(
      { brief: serializeBrief(claim.row), accepted: false, in_progress: true },
      { status: 202 },
    );
  }
  const row = claim.row;

  const task = async () => {
    await runPreparationBrief(row.id, id);
  };

  if (runInlineForPreparationV2()) {
    await task();
  } else {
    try {
      after(() => {
        return task();
      });
    } catch (e) {
      console.warn("[preparation-v2] after() unavailable; running inline", e);
      await task();
    }
  }

  const latest = await prisma.preparationBrief.findUnique({ where: { id: row.id } });
  return NextResponse.json({ brief: serializeBrief(latest), accepted: true }, { status: 202 });
}
