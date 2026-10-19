"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MeetingOwnerType } from "@/lib/meetings/meeting-owner";

const OPTIONS: Array<{ value: MeetingOwnerType; label: string }> = [
  { value: "own_meet", label: "自社発行の Google Meet" },
  { value: "guest_meet", label: "先方発行の Google Meet" },
  { value: "zoom", label: "先方発行の Zoom" },
  { value: "in_person", label: "対面商談" },
  { value: "unknown", label: "未選択" },
];

export function MeetingOwnerSelector({
  dealId,
  initialValue,
  canEdit,
}: {
  dealId: string;
  initialValue: MeetingOwnerType;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<MeetingOwnerType>(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: MeetingOwnerType) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingOwnerType: next }),
      });
      if (!response.ok) throw new Error("save failed");
      router.refresh();
    } catch {
      setValue(previous);
      setError("会議種別を保存できませんでした。再度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-zinc-500" />
          会議の主催者・形式
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-w-md space-y-1.5">
          <Label htmlFor={`meeting-owner-${dealId}`}>この商談の会議種別</Label>
          <Select
            value={value}
            onValueChange={(next) => void save(next as MeetingOwnerType)}
            disabled={!canEdit || saving}
          >
            <SelectTrigger id={`meeting-owner-${dealId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <p role="alert" className="text-[13px] font-semibold text-rose-600">{error}</p>}
        </div>

      </CardContent>
    </Card>
  );
}
