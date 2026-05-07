"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Save, X, Pencil } from "lucide-react";
import { STAGE_GROUP_LABEL, type StageGroup, type PipelineStageRow } from "@/lib/pipeline-stage";

/**
 * 色プリセット：UI から選びやすくする。
 * 自由入力もできるように value=__custom__ も用意。
 */
const COLOR_PRESETS: { label: string; bg: string; text: string }[] = [
  { label: "Sky（青）", bg: "bg-sky-100", text: "text-sky-800" },
  { label: "Blue（濃青）", bg: "bg-blue-100", text: "text-blue-800" },
  { label: "Emerald 薄", bg: "bg-emerald-50", text: "text-emerald-700" },
  { label: "Emerald", bg: "bg-emerald-100", text: "text-emerald-800" },
  { label: "Emerald 濃", bg: "bg-emerald-200", text: "text-emerald-900" },
  { label: "Teal", bg: "bg-teal-100", text: "text-teal-800" },
  { label: "Green", bg: "bg-green-100", text: "text-green-800" },
  { label: "Amber（警告）", bg: "bg-amber-100", text: "text-amber-800" },
  { label: "Orange（契約系）", bg: "bg-orange-100", text: "text-orange-800" },
  { label: "Rose（赤）", bg: "bg-rose-100", text: "text-rose-800" },
  { label: "Violet（紫）", bg: "bg-violet-100", text: "text-violet-800" },
  { label: "Fuchsia（赤紫）", bg: "bg-fuchsia-100", text: "text-fuchsia-800" },
  { label: "Zinc 薄", bg: "bg-zinc-100", text: "text-zinc-600" },
  { label: "Zinc", bg: "bg-zinc-200", text: "text-zinc-700" },
];

function presetIndexFor(bg: string, text: string): number {
  return COLOR_PRESETS.findIndex((p) => p.bg === bg && p.text === text);
}

export function PipelineStagesAdmin({ initial }: { initial: PipelineStageRow[] }) {
  const router = useRouter();
  const [stages, setStages] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 新規追加フォーム
  const [newValue, setNewValue] = useState("");
  const [newGroup, setNewGroup] = useState<StageGroup>("after");
  const [newColorIdx, setNewColorIdx] = useState("0");
  const [newSortOrder, setNewSortOrder] = useState("");

  function resetNew() {
    setNewValue("");
    setNewGroup("after");
    setNewColorIdx("0");
    setNewSortOrder("");
    setAdding(false);
    setError(null);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const preset = COLOR_PRESETS[Number(newColorIdx)] ?? COLOR_PRESETS[0];
    start(async () => {
      const r = await fetch("/api/pipeline-stages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: newValue,
          label: newValue,
          group: newGroup,
          badgeBg: preset.bg,
          badgeText: preset.text,
          sortOrder: newSortOrder ? Number(newSortOrder) : (stages.length + 1) * 10,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      setStages((s) => [...s, j.stage].sort((a, b) => a.sortOrder - b.sortOrder));
      resetNew();
      router.refresh();
    });
  }

  function remove(s: PipelineStageRow) {
    if (!confirm(`「${s.value}」を削除しますか？\n（使用中の場合は自動的に無効化されます）`)) return;
    start(async () => {
      const r = await fetch(`/api/pipeline-stages/${s.id}`, { method: "DELETE" });
      const j = await r.json();
      if (j.message) alert(j.message);
      if (j.mode === "deleted") {
        setStages((arr) => arr.filter((x) => x.id !== s.id));
      } else if (j.stage) {
        setStages((arr) => arr.map((x) => (x.id === s.id ? j.stage : x)));
      }
      router.refresh();
    });
  }

  const grouped: Record<StageGroup, PipelineStageRow[]> = {
    before: stages.filter((s) => s.group === "before"),
    after: stages.filter((s) => s.group === "after"),
    contract: stages.filter((s) => s.group === "contract"),
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600">
          {stages.length} 件 ／ 商談新規作成・商談詳細で選択肢になります
        </p>
        {!adding && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            ステージを追加
          </Button>
        )}
      </div>

      {adding && (
        <form
          onSubmit={add}
          className="space-y-3 p-4 rounded-lg bg-emerald-50/40 border border-emerald-200"
        >
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div className="space-y-1 md:col-span-3">
              <Label className="text-sm">ステージ名（=保存される値）</Label>
              <Input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="例：【商談後】追いかけ7回目"
                required
              />
            </div>
            <div className="space-y-1 md:col-span-1">
              <Label className="text-sm">グループ</Label>
              <Select value={newGroup} onValueChange={(v) => setNewGroup(v as StageGroup)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before">商談前</SelectItem>
                  <SelectItem value="after">商談後</SelectItem>
                  <SelectItem value="contract">契約</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 md:col-span-1">
              <Label className="text-sm">並び順</Label>
              <Input
                type="number"
                value={newSortOrder}
                onChange={(e) => setNewSortOrder(e.target.value)}
                placeholder="自動"
              />
            </div>
            <div className="space-y-1 md:col-span-1">
              <Label className="text-sm">色</Label>
              <Select value={newColorIdx} onValueChange={setNewColorIdx}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLOR_PRESETS.map((p, i) => (
                    <SelectItem key={i} value={String(i)}>
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${p.bg} ${p.text}`}>
                        {p.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">プレビュー：</span>
            {(() => {
              const p = COLOR_PRESETS[Number(newColorIdx)] ?? COLOR_PRESETS[0];
              return (
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${p.bg} ${p.text}`}>
                  {newValue || "（ステージ名）"}
                </span>
              );
            })()}
          </div>
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={resetNew}>
              <X className="h-3.5 w-3.5" />
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending || !newValue}>
              <Save className="h-3.5 w-3.5" />
              保存
            </Button>
          </div>
        </form>
      )}

      {(["before", "after", "contract"] as const).map((g) => (
        <div key={g} className="space-y-2">
          <h3 className="text-sm font-bold text-zinc-700 border-b border-zinc-200 pb-1.5 inline-flex items-center gap-2">
            {STAGE_GROUP_LABEL[g]}
            <Badge variant="outline" className="text-[10px]">
              {grouped[g].length}
            </Badge>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {grouped[g].map((s) => (
              <StageCard
                key={s.id}
                stage={s}
                onSaved={(updated) => {
                  setStages((arr) =>
                    arr
                      .map((x) => (x.id === updated.id ? updated : x))
                      .sort((a, b) => a.sortOrder - b.sortOrder),
                  );
                  router.refresh();
                }}
                onDelete={() => remove(s)}
                pending={pending}
              />
            ))}
            {grouped[g].length === 0 && (
              <p className="text-xs text-zinc-400 px-2 py-3 col-span-full">
                {STAGE_GROUP_LABEL[g]} のステージはまだありません
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StageCard({
  stage,
  onSaved,
  onDelete,
  pending,
}: {
  stage: PipelineStageRow;
  onSaved: (updated: PipelineStageRow) => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(stage.value);
  const [group, setGroup] = useState<StageGroup>(stage.group as StageGroup);
  const initialIdx = presetIndexFor(stage.badgeBg, stage.badgeText);
  const [colorIdx, setColorIdx] = useState(String(initialIdx >= 0 ? initialIdx : 0));
  const [sortOrder, setSortOrder] = useState(String(stage.sortOrder));
  const [active, setActive] = useState(stage.active);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const preset = COLOR_PRESETS[Number(colorIdx)] ?? COLOR_PRESETS[0];
    const r = await fetch(`/api/pipeline-stages/${stage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value,
        label: value,
        group,
        badgeBg: preset.bg,
        badgeText: preset.text,
        sortOrder: Number(sortOrder) || 0,
        active,
      }),
    });
    const j = await r.json();
    setSaving(false);
    if (j.stage) {
      onSaved(j.stage);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <form
        onSubmit={save}
        className="rounded-lg border border-emerald-300 bg-emerald-50/40 p-3 space-y-2"
      >
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1 col-span-3">
            <Label className="text-xs">ステージ名</Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">グループ</Label>
            <Select value={group} onValueChange={(v) => setGroup(v as StageGroup)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="before">商談前</SelectItem>
                <SelectItem value="after">商談後</SelectItem>
                <SelectItem value="contract">契約</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">並び順</Label>
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">色</Label>
            <Select value={colorIdx} onValueChange={setColorIdx}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLOR_PRESETS.map((p, i) => (
                  <SelectItem key={i} value={String(i)}>
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${p.bg} ${p.text}`}>
                      {p.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            有効（選択肢に表示）
          </label>
          <div className="flex gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              <X className="h-3 w-3" />
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              <Save className="h-3 w-3" />
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${stage.badgeBg} ${stage.badgeText}`}
            >
              {stage.value}
            </span>
            {!stage.active && <Badge variant="secondary">無効</Badge>}
          </div>
          <p className="text-[10px] text-zinc-500 mt-1.5">
            並び順: <span className="font-mono">{stage.sortOrder}</span> ／ {stage.badgeBg} {stage.badgeText}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setEditing(true)}
            disabled={pending}
            className="text-zinc-400 hover:text-emerald-600"
            title="編集"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            disabled={pending}
            className="text-zinc-300 hover:text-red-500"
            title="削除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
