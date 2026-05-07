"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

type SalesUser = { id: string; name: string; avatarColor: string | null };

export function OwnerTabs({
  users,
  currentUserId,
  selected,
}: {
  users: SalesUser[];
  currentUserId: string;
  /** "all" | "me" | <userId>。null は "all" 扱い */
  selected: string | null;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(value: string) {
    const params = new URLSearchParams(search);
    params.set("owner", value);
    return `${pathname}?${params.toString()}`;
  }

  const tabs = [
    { value: "all", label: "全員", icon: Users, color: null },
    { value: "me", label: "自分", icon: null, color: null },
    ...users.map((u) => ({ value: u.id, label: u.name, icon: null, color: u.avatarColor })),
  ];

  const sel = selected ?? "all"; // null は全員扱い

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {tabs.map((t) => {
        const active = t.value === sel || (t.value === "me" && sel === currentUserId);
        const Icon = t.icon;
        return (
          <Link
            key={t.value}
            href={buildHref(t.value)}
            className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50",
            )}
          >
            {Icon && <Icon className="h-3 w-3" />}
            {t.color && (
              <span
                className="w-4 h-4 rounded-full text-white text-[9px] font-semibold flex items-center justify-center"
                style={{ background: t.color }}
              >
                {t.label.charAt(0)}
              </span>
            )}
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
