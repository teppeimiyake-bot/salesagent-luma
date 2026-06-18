"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Tag, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { IndustryPicker } from "@/components/companies/industry-picker";

/**
 * 商談詳細ヘッダーから「商談に紐づく企業（Company）の業種」を編集するエディタ。
 *
 * 設計方針:
 * - 業種は Company.industry に紐づく（商談ごとに別の業種は持たない）。
 *   ここで編集した内容は、その商談の企業レコードに保存される。
 * - 企業画面と同じ IndustryPicker（複数選択チップ）・同じ選択肢・同じ保存形式（「,」区切り）を踏襲。
 * - 保存先は既存の PATCH /api/companies/[id]（industry のみ送信）。スキーマ変更なし。
 * - canEdit が false の場合は、クリックできない読み取り専用バッジを表示。
 */
export function DealIndustryEditor({
  companyId,
  companyName,
  /** Company.industry を優先し、無ければ BANT 由来の業種ラベル（読み取り表示用フォールバック） */
  initialIndustry,
  /** 表示用ラベル（companyIndustry が空のとき bant.industry を出すため、別途渡す） */
  displayLabel,
  canEdit,
}: {
  companyId: string;
  companyName: string;
  initialIndustry: string | null;
  displayLabel: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialIndustry ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ industry: value.trim() ? value.trim() : null }),
    });
    setSaving(false);
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  // 読み取り専用（権限なし）：従来通りのバッジのみ
  if (!canEdit) {
    return displayLabel ? <Badge variant="secondary">{displayLabel}</Badge> : null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          // 開くたびに最新の保存値で初期化（router.refresh 後の再表示に追従）
          setValue(initialIndustry ?? "");
          setOpen(true);
        }}
        title="業種を編集"
        className="group inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
      >
        <Tag className="h-3 w-3 opacity-60" />
        {displayLabel || "業種未設定"}
        <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>業種を編集</DialogTitle>
            <DialogDescription>
              {companyName} の業種を設定します（複数選択可）。商談に紐づく企業の業種として保存されます。
            </DialogDescription>
          </DialogHeader>

          <div className="py-1">
            <IndustryPicker value={value} onChange={setValue} variant="light" />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
              キャンセル
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
