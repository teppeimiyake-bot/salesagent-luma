import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { callClaude } from "@/lib/ai/anthropic";
import { JP_TEXT_STYLE_RULE } from "@/lib/ai/text-style";

export const maxDuration = 60;

/** 簡易HTML本文抽出 */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!company.websiteUrl) {
    return NextResponse.json({ error: "websiteUrl is empty" }, { status: 400 });
  }

  let html = "";
  try {
    const res = await fetch(company.websiteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 ReeasySalesAgent/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `HTTP ${res.status} from website` }, { status: 502 });
    }
    html = await res.text();
  } catch (e) {
    // フォールバック：取得失敗時もダミー要約を保存
    const fallback = `${company.name}のサイトは取得できませんでした（ネットワーク／認証制限の可能性）。手動で事業概要を入力してください。`;
    const c = await prisma.company.update({
      where: { id },
      data: { websiteSummary: fallback, websiteFetchedAt: new Date() },
    });
    return NextResponse.json({ company: c, fallback: true, error: String(e) });
  }

  const text = extractText(html);
  const system = `あなたはBtoB営業のリサーチャー。指定された企業のWebサイト本文から、商談前ブリーフィングに必要な情報を抽出する。
出力は以下のフォーマットで日本語：

■ ${company.name}

◆ 事業概要
（3〜5行で。何をやっている会社か、規模感、特徴）

◆ 主要プロダクト/サービス
・...

◆ 直近の動き・ニュース
・...

◆ 営業視点の着眼点（このサイトから読み取れる課題・機会）
・...

事実のみに基づき、推測は明確にラベリングする。

${JP_TEXT_STYLE_RULE}`;
  const user = `URL: ${company.websiteUrl}\n\n本文（抜粋・最大8000字）:\n${text}`;

  const aiText = await callClaude({ system, user, maxTokens: 1200, temperature: 0.3 });
  const summary = aiText ?? `[AIキー未設定] サイトを${text.length}文字取得済み。手動で要約を入力してください。`;

  const updated = await prisma.company.update({
    where: { id },
    data: { websiteSummary: summary, websiteFetchedAt: new Date() },
  });
  return NextResponse.json({ company: updated, fallback: !aiText });
}
