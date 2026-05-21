"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Briefcase,
  Building2,
  BarChart3,
  Sparkles,
  LogOut,
  CheckSquare,
  FolderOpen,
  Users,
  Package,
  Shield,
  Trash2,
  Sparkle,
  GitBranch,
  Film,
  PhoneCall,
  Merge,
} from "lucide-react";

const baseGroups = [
  {
    label: "ワーク",
    items: [
      { href: "/dashboard", label: "ダッシュボード", icon: LayoutDashboard, color: "text-orange-500", activeBg: "bg-orange-500" },
      { href: "/todos", label: "ToDo", icon: CheckSquare, color: "text-orange-500", activeBg: "bg-orange-500" },
      { href: "/deals", label: "商談", icon: Briefcase, color: "text-amber-500", activeBg: "bg-amber-500" },
      { href: "/ms", label: "ms管理", icon: PhoneCall, color: "text-amber-600", activeBg: "bg-amber-600" },
      { href: "/companies", label: "企業", icon: Building2, color: "text-yellow-600", activeBg: "bg-yellow-600" },
    ],
  },
  {
    label: "ナレッジ",
    items: [
      { href: "/documents", label: "提案書・契約書", icon: FolderOpen, color: "text-amber-500", activeBg: "bg-amber-500" },
    ],
  },
  {
    label: "分析",
    items: [
      { href: "/kpi", label: "KPI", icon: BarChart3, color: "text-sky-500", activeBg: "bg-sky-500" },
      { href: "/team", label: "チーム", icon: Users, color: "text-pink-500", activeBg: "bg-pink-500" },
    ],
  },
];

const adminGroup = {
  label: "管理者メニュー",
  items: [
    { href: "/admin/products", label: "カテゴリ", icon: Package, color: "text-rose-500", activeBg: "bg-rose-500" },
    { href: "/admin/plan-proposals", label: "企画提案", icon: Film, color: "text-orange-500", activeBg: "bg-orange-500" },
    { href: "/admin/lead-sources", label: "リード獲得経由", icon: Sparkle, color: "text-fuchsia-500", activeBg: "bg-fuchsia-500" },
    { href: "/admin/pipeline-stages", label: "商談プロセス", icon: GitBranch, color: "text-violet-500", activeBg: "bg-violet-500" },
    { href: "/admin/users", label: "ユーザー権限", icon: Shield, color: "text-red-500", activeBg: "bg-red-500" },
    { href: "/admin/company-merges", label: "企業統合", icon: Merge, color: "text-teal-500", activeBg: "bg-teal-600" },
    { href: "/admin/trash", label: "ゴミ箱", icon: Trash2, color: "text-zinc-500", activeBg: "bg-zinc-700" },
  ],
};

export function Sidebar({
  user,
}: {
  user: { name: string; email: string; avatarColor: string | null; avatarUrl?: string | null; permission: string } | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const groups = user?.permission === "admin" ? [...baseGroups, adminGroup] : baseGroups;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="w-72 shrink-0 border-r border-zinc-200 bg-gradient-to-b from-white to-zinc-50 flex flex-col">
      <div className="px-5 py-5 border-b border-zinc-200 bg-gradient-to-br from-orange-500 via-orange-500 to-amber-500">
        <div className="text-[10px] font-semibold tracking-widest text-white/80 uppercase mb-1.5">
          株式会社Luma
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-white/20 backdrop-blur p-2 shadow-lg">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-bold tracking-tight text-base text-white leading-tight">
              Luma
              <span className="ml-1 text-white/90">Sales Agent</span>
            </div>
            <div className="text-[10px] text-white/70 -mt-0.5">受注を取りにいくAI</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label} className="mb-5">
            <div className="text-xs uppercase tracking-wider text-zinc-500 px-3 mb-2 font-bold">
              {g.label}
            </div>
            <div className="space-y-1">
              {g.items.map((it) => {
                const active = pathname === it.href || pathname.startsWith(it.href + "/");
                const Icon = it.icon;
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-base transition-all",
                      active
                        ? `${it.activeBg} text-white shadow-md font-semibold`
                        : "text-zinc-700 hover:bg-zinc-100 font-medium",
                    )}
                  >
                    <Icon className={cn("h-5 w-5", active ? "text-white" : it.color)} />
                    {it.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-zinc-200 space-y-2">
        {user && (
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gradient-to-br from-zinc-50 to-zinc-100 border border-zinc-200">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/api/auth/avatar"
                alt={user.name}
                className="w-9 h-9 rounded-full object-cover shrink-0 shadow-sm border border-zinc-200"
              />
            ) : (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm"
                style={{ background: user.avatarColor ?? "#6366f1" }}
              >
                {user.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{user.name}</div>
              <div className="text-[11px] text-zinc-500 truncate">{user.email}</div>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
        >
          <LogOut className="h-4 w-4" />
          ログアウト
        </button>
      </div>
    </aside>
  );
}
