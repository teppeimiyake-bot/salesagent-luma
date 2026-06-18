"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X, Loader2 } from "lucide-react";

export type PmStaffRole = "pm" | "director" | "camera" | "editor";

export type PmStaffOption = {
  id: string;
  role: string;
  name: string;
};

// ---- モジュールレベルの簡易共有ストア（PM画面内で options を一度だけ取得して共有） ----
let staffCache: PmStaffOption[] | null = null;
let inflight: Promise<PmStaffOption[]> | null = null;
const subscribers = new Set<(s: PmStaffOption[]) => void>();

function notify() {
  for (const fn of subscribers) fn(staffCache ?? []);
}

async function loadStaff(): Promise<PmStaffOption[]> {
  if (staffCache) return staffCache;
  if (!inflight) {
    inflight = fetch("/api/pm-staff")
      .then((r) => r.json())
      .then((j) => {
        staffCache = (j.staff ?? []) as PmStaffOption[];
        notify();
        return staffCache;
      })
      .catch(() => {
        staffCache = [];
        return staffCache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function addToCache(staff: PmStaffOption) {
  staffCache = [...(staffCache ?? []).filter((s) => s.id !== staff.id), staff];
  notify();
}

/** PM スタッフマスタを購読するフック。初回マウントで一度だけ取得し、追加時に全ピッカーへ反映。 */
function usePmStaff(): PmStaffOption[] {
  const [list, setList] = useState<PmStaffOption[]>(staffCache ?? []);
  useEffect(() => {
    subscribers.add(setList);
    loadStaff();
    return () => {
      subscribers.delete(setList);
    };
  }, []);
  return list;
}

/**
 * PM管理タブの「PM担当 / ディレクター / カメラ / 編集」用ピッカー。
 *
 * - 役割(role)ごとのスタッフマスタ(PmStaff)から選択肢を出すプルダウン
 * - 「＋ 新規スタッフを追加」で、その場でマスタに人員を追加（POST /api/pm-staff）して選択
 * - ProductionProject 側はテキスト保持のため value は「名前文字列」。
 *   マスタに無い既存テキスト値（社外スタッフ等）も先頭にそのまま表示して壊さない。
 */
export function StaffPicker({
  role,
  value,
  canEdit,
  onChange,
  className = "",
  width = "w-[140px]",
}: {
  role: PmStaffRole;
  value: string | null;
  canEdit: boolean;
  onChange: (name: string | null) => void;
  className?: string;
  width?: string;
}) {
  const options = usePmStaff();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const roleOptions = options.filter((o) => o.role === role);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!canEdit) {
    return <span className="text-sm">{value ?? "—"}</span>;
  }

  const hasValueInMaster = !!value && roleOptions.some((o) => o.name === value);
  const extraValue = value && !hasValueInMaster ? value : null;

  async function addStaff(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/pm-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, name }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      addToCache({ id: j.staff.id, role: j.staff.role, name: j.staff.name });
      onChange(j.staff.name);
      setNewName("");
      setAdding(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  function pick(name: string | null) {
    onChange(name);
    setOpen(false);
  }

  return (
    <div className={`relative inline-block ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 ${width} items-center justify-between gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 hover:bg-zinc-50 focus:outline-none focus:ring-1 focus:ring-emerald-400`}
      >
        <span className={`truncate ${value ? "" : "text-zinc-400"}`}>{value ?? "未割当"}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 max-h-[280px] w-[200px] overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg">
          <button
            type="button"
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-50"
          >
            <span className="w-3.5">{value == null && <Check className="h-3.5 w-3.5 text-emerald-500" />}</span>
            未割当
          </button>

          {extraValue && (
            <button
              type="button"
              onClick={() => pick(extraValue)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50"
            >
              <span className="w-3.5"><Check className="h-3.5 w-3.5 text-emerald-500" /></span>
              <span className="truncate">{extraValue}</span>
              <span className="ml-auto text-[10px] text-zinc-400">手入力</span>
            </button>
          )}

          {roleOptions.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => pick(o.name)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50"
            >
              <span className="w-3.5">
                {value === o.name && <Check className="h-3.5 w-3.5 text-emerald-500" />}
              </span>
              <span className="truncate">{o.name}</span>
            </button>
          ))}

          <div className="my-1 border-t border-zinc-100" />

          {adding ? (
            <form onSubmit={addStaff} className="px-2 py-1">
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="新しい人員名"
                  className="h-7 w-full rounded border border-zinc-200 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <button
                  type="submit"
                  disabled={busy || !newName.trim()}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
                  title="追加"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewName("");
                    setError(null);
                  }}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-200 text-zinc-400 hover:bg-zinc-50"
                  title="キャンセル"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {error && <p className="mt-1 text-[10px] text-red-600">{error}</p>}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-emerald-600 hover:bg-emerald-50"
            >
              <Plus className="h-3.5 w-3.5" />
              新規スタッフを追加
            </button>
          )}
        </div>
      )}
    </div>
  );
}
