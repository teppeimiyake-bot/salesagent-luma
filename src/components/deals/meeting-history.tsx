"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MinutesEditor } from "./minutes-editor";
import { CalendarDays, Plus, ChevronDown, ChevronUp, Trash2, Sparkles, Mic, Target } from "lucide-react";
import { formatDate } from "@/lib/utils";

type MeetingItem = {
  id: string;
  title: string | null;
  meetingDate: Date | string;
  minutes: string | null;
  transcript: string | null;
  summary: string | null;
  bantBudget: string | null;
  bantAuthority: string | null;
  bantNeed: string | null;
  bantTimeline: string | null;
};

export function MeetingHistory({
  dealId,
  meetings,
}: {
  dealId: string;
  meetings: MeetingItem[];
}) {
  const router = useRouter();
  const [openIds, setOpenIds] = useState<Set<string>>(
    new Set(meetings[0] ? [meetings[0].id] : []),
  );
  const [pending, start] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));

  // タイトル：明示があれば優先、なければ「第N回 商談」（古→新で番号）
  const ordered = [...meetings].sort(
    (a, b) => new Date(a.meetingDate).getTime() - new Date(b.meetingDate).getTime(),
  );
  const labelById = new Map<string, string>();
  ordered.forEach((m, idx) => {
    labelById.set(m.id, m.title ?? `第${idx + 1}回 商談`);
  });

  function toggle(id: string) {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  }

  async function createMeeting() {
    start(async () => {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId,
          meetingDate: new Date(newDate).toISOString(),
        }),
      });
      const j = await res.json();
      if (j.meeting) {
        // タイトル指定があればPATCH
        if (newTitle.trim()) {
          await fetch(`/api/meetings/${j.meeting.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: newTitle.trim() }),
          });
        }
        setOpenIds((s) => new Set(s).add(j.meeting.id));
        setCreating(false);
        setNewTitle("");
        router.refresh();
      }
    });
  }

  function remove(id: string) {
    if (!confirm("この商談記録を削除しますか？（議事録・BANT・AI分析もすべて消えます）")) return;
    start(async () => {
      await fetch(`/api/meetings/${id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  return (
    <Card className="border-orange-200 bg-gradient-to-br from-orange-50/40 via-white to-amber-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
              <CalendarDays className="h-4 w-4" />
            </div>
            商談履歴
            <Badge variant="secondary">{meetings.length}回</Badge>
          </span>
          <Button size="sm" variant="primary" onClick={() => setCreating(!creating)}>
            <Plus className="h-3.5 w-3.5" />
            新しい商談を記録
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {creating && (
          <div className="rounded-lg border border-orange-200 bg-orange-50/40 p-4 space-y-3">
            <p className="text-sm font-medium text-orange-900 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> 新しい商談記録を追加
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2 space-y-1">
                <Label className="text-xs">商談ラベル（任意）</Label>
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="例: 第3回 役員レビュー"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">商談日</Label>
                <Input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                キャンセル
              </Button>
              <Button size="sm" variant="primary" onClick={createMeeting} disabled={pending}>
                <Plus className="h-3.5 w-3.5" /> 追加
              </Button>
            </div>
            <p className="text-xs text-zinc-500">
              追加後、各回ごとに議事録・録音・BANT・AI分析を独立して記録できます。
            </p>
          </div>
        )}

        {meetings.length === 0 ? (
          <div className="text-center py-8">
            <Mic className="h-10 w-10 text-orange-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500 mb-3">
              まだ商談記録がありません。録音 / 議事録アップロード / 「新しい商談を記録」のいずれかで開始してください。
            </p>
          </div>
        ) : (
          // 新しい順で表示
          [...meetings]
            .sort((a, b) => new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime())
            .map((m, idx) => {
              const isOpen = openIds.has(m.id);
              const isLatest = idx === 0;
              const label = labelById.get(m.id) ?? "商談";
              return (
                <div
                  key={m.id}
                  className={`rounded-lg border ${isLatest ? "border-orange-300 bg-white shadow-sm" : "border-zinc-200 bg-white"}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 rounded-lg transition-colors"
                  >
                    <div
                      className={`rounded-md p-1.5 ${isLatest ? "bg-orange-500 text-white" : "bg-zinc-100 text-zinc-500"}`}
                    >
                      <CalendarDays className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{label}</p>
                        {isLatest && <Badge variant="info">最新</Badge>}
                        <span className="text-xs text-zinc-500">{formatDate(m.meetingDate)}</span>
                      </div>
                      {m.summary && (
                        <p className="text-xs text-zinc-500 truncate mt-0.5">{m.summary}</p>
                      )}
                    </div>
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(m.id);
                      }}
                      className="text-zinc-300 hover:text-red-500"
                      title="削除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </span>
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 text-zinc-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-zinc-400" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-0 space-y-3 border-t border-zinc-100">
                      <MeetingTitleEditor meetingId={m.id} initialTitle={m.title} />
                      <MinutesEditor
                        meetingId={m.id}
                        initialMinutes={m.minutes ?? ""}
                        initialTranscript={m.transcript ?? ""}
                        meetingDate={m.meetingDate}
                      />
                      {/* この回のBANTメモ（履歴・閲覧のみ。案件全体のBANTは商談ページの上部「BANT情報」で一元管理） */}
                      {(m.bantBudget || m.bantAuthority || m.bantNeed || m.bantTimeline) && (
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
                          <p className="text-xs text-zinc-500 inline-flex items-center gap-1 mb-2">
                            <Target className="h-3 w-3" />
                            この回でのBANTメモ（履歴）
                            <span className="text-[10px] text-zinc-400">
                              ※ 編集は商談ページ上部の「BANT情報」で行います
                            </span>
                          </p>
                          <dl className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                            {[
                              { label: "B / 予算", v: m.bantBudget },
                              { label: "A / 決裁", v: m.bantAuthority },
                              { label: "N / 必要性", v: m.bantNeed },
                              { label: "T / 時期", v: m.bantTimeline },
                            ].map((row) =>
                              row.v ? (
                                <div key={row.label} className="bg-white rounded px-2 py-1.5 border border-zinc-100">
                                  <dt className="text-[10px] text-zinc-500">{row.label}</dt>
                                  <dd className="text-zinc-800">{row.v}</dd>
                                </div>
                              ) : null,
                            )}
                          </dl>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
        )}
      </CardContent>
    </Card>
  );
}

function MeetingTitleEditor({
  meetingId,
  initialTitle,
}: {
  meetingId: string;
  initialTitle: string | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() || null }),
    });
    setSaving(false);
    router.refresh();
  }

  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 space-y-1">
        <Label className="text-xs text-zinc-500">この回のラベル</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例: 第3回 役員レビュー / クロージング MTG"
          className="h-9"
        />
      </div>
      <Button size="sm" variant="outline" onClick={save} disabled={saving}>
        {saving ? "保存中..." : "ラベル保存"}
      </Button>
    </div>
  );
}
