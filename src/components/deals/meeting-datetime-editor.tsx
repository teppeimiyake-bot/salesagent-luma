"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DateTimeInput } from "@/components/ui/datetime-input";
import {
  isEndBeforeStart,
  jstDateTimeInputToIso,
  toJstDateTimeInput,
} from "@/lib/meeting-datetime";

type Props = {
  dealId: string;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
  canEdit?: boolean;
  disabled?: boolean;
  onSaved?: (start: string | null, end: string | null) => void;
};

/** Updated server values reset the draft; failed saves keep it available for retry. */
export function MeetingDateTimeEditor(props: Props) {
  const start = toJstDateTimeInput(props.startAt);
  const end = toJstDateTimeInput(props.endAt);
  return <Editor key={`${props.dealId}:${start}:${end}`} {...props} initialStart={start} initialEnd={end} />;
}

function Editor({ dealId, canEdit = true, disabled = false, onSaved, initialStart, initialEnd }:
  Props & { initialStart: string; initialEnd: string }) {
  const router = useRouter();
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);

  async function save(nextStart: string, nextEnd: string) {
    if (inFlight.current || disabled || !canEdit) return;
    setSaved(false);
    const startIso = jstDateTimeInputToIso(nextStart);
    const endIso = jstDateTimeInputToIso(nextEnd);
    if ((nextStart && !startIso) || (nextEnd && !endIso)) {
      setError("正しい日時を入力してください。");
      return;
    }
    if (endIso && !startIso) {
      setError("開始日時を先に入力してください。");
      return;
    }
    if (isEndBeforeStart(startIso, endIso)) {
      setError("終了日時は開始日時以降にしてください。変更は保存されていません。");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingStartAt: startIso, meetingEndAt: endIso }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setError(result?.message ?? "日時を保存できませんでした。入力を確認して再試行してください。");
        return;
      }
      setSaved(true);
    } catch {
      setError("通信に失敗しました。入力内容は残っています。再試行してください。");
      return;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
    onSaved?.(startIso, endIso);
    router.refresh();
  }

  if (!canEdit) {
    return <span className="text-sm font-semibold tabular-nums text-amber-700">
      {start ? `${start.replace("T", " ")}${end ? ` 〜 ${end.replace("T", " ")}` : ""}` : "未設定"}
    </span>;
  }

  return <div className="space-y-2">
    <div className="flex items-center gap-2 flex-wrap">
      <label className="space-y-1">
        <span className="block text-xs text-zinc-500">開始日時</span>
        <DateTimeInput value={start} aria-label="商談開始日時" disabled={disabled || saving}
          onChange={(value) => {
            setStart(value);
            let nextEnd = end;
            if (!value) nextEnd = "";
            else {
              const iso = jstDateTimeInputToIso(value);
              if (iso && (!end || isEndBeforeStart(iso, jstDateTimeInputToIso(end)))) {
                nextEnd = toJstDateTimeInput(new Date(new Date(iso).getTime() + 60 * 60 * 1000));
              }
            }
            setEnd(nextEnd);
            void save(value, nextEnd);
          }} />
      </label>
      <span className="text-sm text-zinc-400">〜</span>
      <label className="space-y-1">
        <span className="block text-xs text-zinc-500">終了日時</span>
        <DateTimeInput value={end} aria-label="商談終了日時" disabled={disabled || saving}
          onChange={(value) => { setEnd(value); void save(start, value); }} />
      </label>
      {(start || end) && <Button type="button" size="sm" variant="ghost" disabled={disabled || saving}
        onClick={() => { setStart(""); setEnd(""); void save("", ""); }}>クリア</Button>}
    </div>
    <p className="text-xs text-zinc-500">日本時間。入力欄から移動すると自動保存します。</p>
    {saving && <p role="status" className="text-sm text-zinc-500">保存中…</p>}
    {saved && !saving && <p role="status" className="text-sm text-green-700">保存しました。</p>}
    {error && <div role="alert" className="text-sm text-rose-600">
      {error}
      <Button type="button" size="sm" variant="outline" className="ml-2" disabled={disabled || saving}
        onClick={() => void save(start, end)}>再試行</Button>
    </div>}
  </div>;
}
