import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { callClaude } from "@/lib/ai/anthropic";
import { hasAiTextKey } from "@/lib/ai/provider";
import { JP_JSON_TEXT_STYLE_RULE } from "@/lib/ai/text-style";

const schema = z.object({
  query: z.string().min(1),
  category: z.string().optional(),
});

/** ナレッジ類似検索：
 * 1) Claude APIキーがあれば、LLMで意味的に類似のドキュメントを順位付け
 * 2) なければ、キーワード（query/tags/name/description）部分一致
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { query, category } = parsed.data;

  const candidates = await prisma.document.findMany({
    where: { ...(category ? { category } : {}), scope: "global" },
    take: 50,
  });

  // キーワード prefilter
  const lower = query.toLowerCase();
  const keywords = lower.split(/[\s、,。.]+/).filter(Boolean);
  const scored = candidates
    .map((d) => {
      const haystack = [d.name, d.description ?? "", ...(d.tags ?? [])].join(" ").toLowerCase();
      let score = 0;
      for (const k of keywords) if (haystack.includes(k)) score += 1;
      return { doc: d, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (hasAiTextKey()) {
    // AIによる意味検索＋類似度コメント生成（プロバイダはAI_PROVIDERに従う）
    const top = scored.slice(0, 10).length > 0 ? scored.slice(0, 10) : candidates.slice(0, 10).map((d) => ({ doc: d, score: 0 }));
    const system = `あなたは営業ナレッジの司書。ユーザーの課題クエリに対し、与えられた事例リストから最も関連の高いものを上位5件に絞り、関連理由を1行で添える。
出力は厳密にJSON：
{
  "results": [
    { "id": "...", "relevance": 0-100, "reason": "..." }
  ]
}

${JP_JSON_TEXT_STYLE_RULE}`;
    const user = `# クエリ\n${query}\n\n# 候補事例\n${top.map((s, i) => `${i + 1}. id=${s.doc.id} / ${s.doc.name}\n   tags: ${s.doc.tags.join(", ")}\n   ${s.doc.description ?? ""}`).join("\n\n")}\n\nJSONのみ出力。`;
    const text = await callClaude({ system, user, maxTokens: 1500, temperature: 0.2 });
    if (text) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as { results: Array<{ id: string; relevance: number; reason: string }> };
          const map = new Map(top.map((s) => [s.doc.id, s.doc]));
          const results = parsed.results
            .filter((r) => map.has(r.id))
            .map((r) => ({ ...map.get(r.id)!, relevance: r.relevance, reason: r.reason }));
          return NextResponse.json({ results, mode: "ai" });
        } catch {
          /* fall through to keyword */
        }
      }
    }
  }

  // フォールバック：キーワード検索のみ
  return NextResponse.json({
    results: scored.slice(0, 10).map((s) => ({
      ...s.doc,
      relevance: Math.min(100, s.score * 25),
      reason: `キーワード一致: ${keywords.filter((k) => [s.doc.name, s.doc.description ?? "", ...(s.doc.tags ?? [])].join(" ").toLowerCase().includes(k)).join(", ")}`,
    })),
    mode: "keyword",
  });
}
