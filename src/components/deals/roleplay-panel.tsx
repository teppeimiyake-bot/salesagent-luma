"use client";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Mic, MicOff, Send, Sparkles, Volume2, VolumeX, Smile, Meh, Skull } from "lucide-react";

// Web Speech Recognition の最低限の型
interface SpeechRecognitionResult { 0: { transcript: string }; isFinal: boolean }
interface SpeechRecognitionEvent extends Event { resultIndex: number; results: { length: number; [n: number]: SpeechRecognitionResult } }
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type Turn = { role: string; content: string };

const LEVELS = [
  { level: 1, label: "初級", desc: "協力的な顧客", icon: Smile, color: "from-emerald-500 to-teal-500" },
  { level: 2, label: "中級", desc: "標準的な顧客", icon: Meh, color: "from-amber-500 to-orange-500" },
  { level: 3, label: "上級", desc: "難しい顧客", icon: Skull, color: "from-red-500 to-rose-600" },
];

export function RoleplayPanel({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<1 | 2 | 3>(2);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [persona, setPersona] = useState<{ name: string; role: string } | null>(null);
  const [log, setLog] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    setSupported(!!Ctor);
  }, []);

  function toggleListen() {
    if (typeof window === "undefined") return;
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new Ctor();
    rec.lang = "ja-JP";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInput((prev) => (final ? prev + final : prev) + (interim ? `…${interim}` : ""));
      if (final) {
        setInput((prev) => prev.replace(/…[^…]*$/, ""));
      }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  function speak(text: string) {
    if (!voiceOn || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 1.05;
    u.pitch = level === 3 ? 0.85 : level === 1 ? 1.1 : 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  async function start() {
    setLoading(true);
    const r = await fetch("/api/roleplay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId, level }),
    });
    const j = await r.json();
    setSessionId(j.session.id);
    setPersona({ name: j.session.personaName, role: j.session.personaRole });
    setLog([
      {
        role: "system",
        content: `${j.session.personaName}さん（${j.session.personaRole}）とのロープレ開始。営業トークから始めてください。`,
      },
    ]);
    setLoading(false);
  }

  async function send() {
    if (!input.trim() || !sessionId) return;
    const userMsg = input.trim();
    setLog((l) => [...l, { role: "user", content: userMsg }]);
    setInput("");
    setLoading(true);
    const r = await fetch("/api/roleplay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: userMsg }),
    });
    const j = await r.json();
    setLog((l) => [...l, { role: "customer", content: j.reply }]);
    speak(j.reply);
    setLoading(false);
  }

  return (
    <Card className="border-orange-200 bg-gradient-to-br from-orange-50/50 via-white to-amber-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
              <Mic className="h-4 w-4" />
            </div>
            AI商談ロープレ
            {sessionId && (
              <Badge variant="info" className="ml-1">
                Lv {level}
              </Badge>
            )}
          </span>
          {!open && (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <Sparkles className="h-3.5 w-3.5" />
              開始
            </Button>
          )}
          {sessionId && (
            <button
              onClick={() => setVoiceOn(!voiceOn)}
              className="text-zinc-400 hover:text-zinc-600"
              title={voiceOn ? "音声ON" : "音声OFF"}
            >
              {voiceOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          )}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          {!sessionId ? (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600">難易度を選んでロープレを開始</p>
              <div className="grid grid-cols-3 gap-3">
                {LEVELS.map((l) => {
                  const Icon = l.icon;
                  const active = level === l.level;
                  return (
                    <button
                      key={l.level}
                      onClick={() => setLevel(l.level as 1 | 2 | 3)}
                      className={`rounded-xl p-4 text-left transition-all ${
                        active
                          ? `bg-gradient-to-br ${l.color} text-white shadow-md`
                          : "bg-white border border-zinc-200 hover:border-orange-300"
                      }`}
                    >
                      <Icon className="h-5 w-5 mb-2" />
                      <p className="font-bold text-sm">
                        Lv {l.level} ・ {l.label}
                      </p>
                      <p className={`text-xs mt-1 ${active ? "text-white/80" : "text-zinc-500"}`}>
                        {l.desc}
                      </p>
                    </button>
                  );
                })}
              </div>
              <Button variant="primary" onClick={start} disabled={loading} className="w-full">
                <Sparkles className="h-4 w-4" />
                {loading ? "準備中..." : `Lv ${level} でロープレ開始`}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {persona && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-gradient-to-br from-zinc-50 to-orange-50/50 border border-orange-200">
                  <div
                    className={`w-12 h-12 rounded-full bg-gradient-to-br ${LEVELS[level - 1].color} text-white font-bold flex items-center justify-center text-lg shadow-md`}
                  >
                    {persona.name.charAt(0)}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-sm">{persona.name}</p>
                    <p className="text-xs text-zinc-500">{persona.role}</p>
                  </div>
                  <Badge variant="info">{LEVELS[level - 1].desc}</Badge>
                </div>
              )}
              <div className="rounded-lg bg-white border border-zinc-200 p-3 max-h-[420px] overflow-y-auto space-y-2.5">
                {log.map((t, i) => (
                  <div key={i}>
                    {t.role === "system" ? (
                      <div className="text-xs text-zinc-400 italic text-center py-2">{t.content}</div>
                    ) : (
                      <div className={t.role === "user" ? "text-right" : "flex items-start gap-2"}>
                        {t.role === "customer" && persona && (
                          <div
                            className={`w-8 h-8 rounded-full bg-gradient-to-br ${LEVELS[level - 1].color} text-white text-xs font-bold flex items-center justify-center shrink-0`}
                          >
                            {persona.name.charAt(0)}
                          </div>
                        )}
                        <p
                          className={
                            t.role === "user"
                              ? "bg-orange-500 text-white text-sm rounded-2xl rounded-br-md px-3.5 py-2 inline-block max-w-[85%]"
                              : "bg-zinc-50 text-zinc-800 text-sm rounded-2xl rounded-bl-md px-3.5 py-2 inline-block max-w-[85%]"
                          }
                        >
                          {t.content}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="text-xs text-zinc-400 italic">顧客が考えています...</div>
                )}
                <div ref={bottomRef} />
              </div>
              <div className="flex gap-2">
                {supported && (
                  <Button
                    variant={listening ? "destructive" : "outline"}
                    onClick={toggleListen}
                    disabled={loading}
                    title={listening ? "音声入力停止" : "音声入力開始"}
                  >
                    {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </Button>
                )}
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
                  placeholder={listening ? "🎙 話してください..." : "営業として話しかける..."}
                  disabled={loading}
                />
                <Button variant="primary" onClick={send} disabled={loading || !input.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex justify-between items-center">
                <p className="text-[11px] text-zinc-500">
                  {voiceOn ? "🔊 顧客の発言を音声で再生" : "🔇 音声OFF"}
                  {supported ? " ／ 🎙 マイクボタンで音声入力可" : " ／ ⚠ このブラウザは音声入力非対応"}
                </p>
                <button
                  onClick={() => {
                    setSessionId(null);
                    setLog([]);
                    setPersona(null);
                  }}
                  className="text-xs text-zinc-500 hover:text-red-500"
                >
                  セッション終了
                </button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
