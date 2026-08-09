"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

type UserOption = { id: string; name: string; avatarColor: string | null };

// ---- モジュールレベルの簡易共有ストア（PM画面内で一度だけ取得して全ピッカーで共有） ----
let userCache: UserOption[] | null = null;
let inflight: Promise<UserOption[]> | null = null;
const subscribers = new Set<(u: UserOption[]) => void>();

async function loadUsers(): Promise<UserOption[]> {
  if (userCache) return userCache;
  if (!inflight) {
    inflight = fetch("/api/users")
      .then((r) => r.json())
      .then((j) => {
        userCache = (j.users ?? []) as UserOption[];
        for (const fn of subscribers) fn(userCache);
        return userCache;
      })
      .catch(() => {
        userCache = [];
        return userCache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function useUsers(): UserOption[] {
  const [list, setList] = useState<UserOption[]>(userCache ?? []);
  useEffect(() => {
    subscribers.add(setList);
    loadUsers();
    return () => {
      subscribers.delete(setList);
    };
  }, []);
  return list;
}

/**
 * PM担当ピッカー：このツールの登録メンバー（User）から選ぶ。
 *
 * ProductionProject.pmName はテキスト保持のため、選択結果は「名前文字列」で渡す。
 * Notion 取込などでマスタに無い名前が既に入っている場合は、消してしまわないよう
 * 先頭に「手入力」として残す。
 */
export function UserPicker({
  value,
  canEdit,
  onChange,
  className = "",
  width = "w-[120px]",
}: {
  value: string | null;
  canEdit: boolean;
  onChange: (name: string | null) => void;
  className?: string;
  width?: string;
}) {
  const users = useUsers();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!canEdit) {
    return <span className="text-sm">{value ?? "—"}</span>;
  }

  const extraValue = value && !users.some((u) => u.name === value) ? value : null;

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
            <span className="w-3.5">
              {value == null && <Check className="h-3.5 w-3.5 text-emerald-500" />}
            </span>
            未割当
          </button>

          {extraValue && (
            <button
              type="button"
              onClick={() => pick(extraValue)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50"
            >
              <span className="w-3.5">
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              </span>
              <span className="truncate">{extraValue}</span>
              <span className="ml-auto text-[10px] text-zinc-400">手入力</span>
            </button>
          )}

          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => pick(u.name)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50"
            >
              <span className="w-3.5">
                {value === u.name && <Check className="h-3.5 w-3.5 text-emerald-500" />}
              </span>
              <span
                className="inline-block h-4 w-4 shrink-0 rounded-full"
                style={{ backgroundColor: u.avatarColor ?? "#a1a1aa" }}
              />
              <span className="truncate">{u.name}</span>
            </button>
          ))}

          {users.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-zinc-400">
              メンバーがいません。「チーム」画面から追加してください。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
