"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save, Target } from "lucide-react";

export function BantEditor({
  meetingId,
  initial,
}: {
  meetingId: string;
  initial: {
    bantBudget: string | null;
    bantAuthority: string | null;
    bantNeed: string | null;
    bantTimeline: string | null;
  };
}) {
  const router = useRouter();
  const [v, setV] = useState({
    bantBudget: initial.bantBudget ?? "",
    bantAuthority: initial.bantAuthority ?? "",
    bantNeed: initial.bantNeed ?? "",
    bantTimeline: initial.bantTimeline ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function save() {
    setSaving(true);
    await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
    setSaving(false);
    setSavedAt(new Date());
    router.refresh();
  }

  const fields = [
    { key: "bantBudget", label: "B / Budget（予算）" },
    { key: "bantAuthority", label: "A / Authority（決裁）" },
    { key: "bantNeed", label: "N / Need（必要性）" },
    { key: "bantTimeline", label: "T / Timeline（時期）" },
  ] as const;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4 text-emerald-600" />
          BANT（編集可・差分は学習に反映）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label className="text-xs text-zinc-600">{f.label}</Label>
            <Textarea
              value={v[f.key]}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
              rows={2}
            />
          </div>
        ))}
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-zinc-400">
            {savedAt ? `保存しました ${savedAt.toLocaleTimeString("ja-JP")}` : "編集後に保存"}
          </p>
          <Button size="sm" variant="primary" onClick={save} disabled={saving}>
            <Save className="h-3.5 w-3.5" /> 保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
