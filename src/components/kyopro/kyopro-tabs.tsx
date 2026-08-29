"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { CalendarDays, ClipboardList, Users, Settings2, Wallet } from "lucide-react";

const TABS = [
  { href: "/kyopro", label: "カレンダー", icon: CalendarDays },
  { href: "/kyopro/shoots", label: "撮影会一覧", icon: ClipboardList },
  { href: "/kyopro/staff", label: "人材", icon: Users },
  // 金額の確定・ステータス変更は admin のみ（要件定義 §8）
  { href: "/kyopro/billing", label: "請求・支払", icon: Wallet, adminOnly: true },
  { href: "/kyopro/masters", label: "マスタ", icon: Settings2, adminOnly: true },
];

export function KyoproTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <div className="border-b border-zinc-200 bg-white px-6">
      <nav className="flex gap-1 -mb-px">
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => {
          // /kyopro は前方一致だと全タブが有効になるので完全一致で判定する
          const active = t.href === "/kyopro" ? pathname === "/kyopro" : pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-3 text-sm border-b-2 transition-colors",
                active
                  ? "border-emerald-600 text-emerald-700 font-semibold"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 hover:border-zinc-300",
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
