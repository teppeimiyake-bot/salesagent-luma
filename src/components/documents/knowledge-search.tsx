"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Sparkles, FileText, Download } from "lucide-react";

type Result = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  fileUrl: string;
  tags: string[];
  relevance: number;
  reason: string;
};

const SUGGESTIONS = [
  "決裁者を巻き込む方法",
  "製造業の生産性改善事例",
  "金融業のCRM刷新事例",
  "営業AIの導入効果",
];

export function KnowledgeSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"ai" | "keyword" | null>(null);

  async function search(q?: string) {
    const text = (q ?? query).trim();
    if (!text) return;
    setLoading(true);
    setQuery(text);
    const r = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: text }),
    });
    const j = await r.json();
    setResults(j.results ?? []);
    setMode(j.mode);
    setLoading(false);
  }

  return (
    <Card className="border-amber-200 bg-gradient-to-br from-amber-50/50 via-white to-orange-50/30 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <div className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white p-1.5 shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          ナレッジAI検索
          <Badge variant="warning" className="ml-1">類似事例</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())}
              placeholder="課題・業界・キーワードで類似事例を検索..."
              className="pl-9"
            />
          </div>
          <Button variant="primary" onClick={() => search()} disabled={loading || !query.trim()}>
            <Sparkles className="h-4 w-4" />
            {loading ? "検索中..." : "AI検索"}
          </Button>
        </div>

        {results.length === 0 && !loading && (
          <div>
            <p className="text-xs text-zinc-500 mb-2">検索例:</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => search(s)}
                  className="text-xs text-amber-700 bg-white border border-amber-200 rounded-md px-3 py-1.5 hover:bg-amber-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {results.length > 0 && (
          <>
            <p className="text-xs text-zinc-500">
              {mode === "ai" ? "AI類似度ランキング" : "キーワード一致"} ／ {results.length} 件
            </p>
            <ul className="space-y-2">
              {results.map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg border border-zinc-200 bg-white p-3 hover:border-amber-300 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-md bg-amber-100 p-1.5">
                      <FileText className="h-4 w-4 text-amber-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{r.name}</span>
                        <Badge variant="info" className="text-[10px]">
                          関連度 {r.relevance}
                        </Badge>
                      </div>
                      {r.description && (
                        <p className="text-xs text-zinc-500 mt-0.5">{r.description}</p>
                      )}
                      <p className="text-xs text-zinc-700 mt-1.5 italic">💡 {r.reason}</p>
                      {r.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {r.tags.map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px]">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    {r.fileUrl.startsWith("/uploads/") && (
                      <a
                        href={r.fileUrl}
                        download
                        className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1 shrink-0"
                      >
                        <Download className="h-3.5 w-3.5" />
                        DL
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
