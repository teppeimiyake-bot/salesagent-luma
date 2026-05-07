"use client";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, RefreshCw, Lightbulb } from "lucide-react";

type Msg = { id?: string; role: "user" | "assistant" | "system"; content: string };

const SUGGESTIONS = [
  "今週、最優先で動くべき案件は？",
  "決裁者を巻き込む具体的な方法を教えて",
  "失注リスクが高い案件はどれ？",
  "次の商談で必ず聞くべき質問は？",
];

export function AiChat({ scope = "global" }: { scope?: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  async function load() {
    const r = await fetch(`/api/chat?scope=${encodeURIComponent(scope)}`);
    const j = await r.json();
    setMessages(j.messages ?? []);
  }
  useEffect(() => {
    load();
  }, [scope]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(content?: string) {
    const text = (content ?? input).trim();
    if (!text) return;
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, content: text }),
    });
    const j = await r.json();
    setMessages((m) => [...m, { role: "assistant", content: j.reply }]);
    setLoading(false);
  }

  return (
    <Card className="flex flex-col h-full border-orange-200 bg-gradient-to-br from-orange-50/50 via-white to-amber-50/30 shadow-sm">
      <CardHeader className="pb-3 shrink-0">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            AIエージェント
          </span>
          <button onClick={load} className="text-zinc-400 hover:text-zinc-600" title="再読み込み">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-3 overflow-hidden">
        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
          {messages.length === 0 && (
            <div>
              <div className="text-sm text-zinc-600 leading-relaxed mb-3">
                <Lightbulb className="h-4 w-4 inline text-amber-500 mr-1" />
                聞きたいことを選ぶか、直接入力してください
              </div>
              <div className="space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    disabled={loading}
                    className="w-full text-left text-xs text-orange-700 bg-white border border-orange-200 rounded-lg px-3 py-2 hover:bg-orange-50 hover:border-orange-400 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              <div
                className={
                  m.role === "user"
                    ? "inline-block bg-orange-500 text-white text-sm rounded-2xl rounded-br-md px-3.5 py-2 max-w-[90%] text-left"
                    : "inline-block bg-white border border-zinc-200 text-sm text-zinc-800 rounded-2xl rounded-bl-md px-3.5 py-2 max-w-[90%] whitespace-pre-wrap shadow-sm"
                }
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="text-xs text-zinc-400 italic flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
              AIが考えています...
            </div>
          )}
          <div ref={bottom} />
        </div>

        {messages.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.slice(0, 2).map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={loading}
                className="text-[11px] text-orange-600 bg-orange-50 hover:bg-orange-100 px-2 py-1 rounded-md"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2 shrink-0">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
            placeholder="質問する..."
            disabled={loading}
            className="text-sm"
          />
          <Button variant="primary" size="sm" onClick={() => send()} disabled={loading || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
