"use client";
import Link from "next/link";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { TenantTabs, ALL_TENANTS_CODE } from "@/components/layout/tenant-tabs";
import type { MyTenant } from "@/lib/tenant-context";
import {
  Menu,
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
  PhoneOutgoing,
  ExternalLink,
  Merge,
  Wallet,
  Clapperboard,
  Send,
  Users2,
  Tag,
  ClipboardCheck,
  Bot,
  Camera,
  FileText,
  FileCog,
} from "lucide-react";

const baseGroups = [
  {
    label: "ワーク",
    items: [
      { href: "/dashboard", label: "ダッシュボード", icon: LayoutDashboard, color: "text-orange-500", activeBg: "bg-orange-500" },
      { href: "/agent", label: "リスト作成AI", icon: Bot, color: "text-indigo-500", activeBg: "bg-indigo-500" },
      { href: "/todos", label: "ToDo", icon: CheckSquare, color: "text-orange-500", activeBg: "bg-orange-500" },
      // 架電エージェント（Luma 架電管理）へ別タブで遷移する外部リンク
      { href: "https://callagent-luma.vercel.app", label: "架電エージェント", icon: PhoneOutgoing, color: "text-orange-600", activeBg: "bg-orange-600", external: true },
      { href: "/deals", label: "商談", icon: Briefcase, color: "text-amber-500", activeBg: "bg-amber-500" },
      { href: "/ms", label: "ms管理", icon: PhoneCall, color: "text-amber-600", activeBg: "bg-amber-600" },
      { href: "/ms-outreach", label: "MS送付状況", icon: Send, color: "text-amber-600", activeBg: "bg-amber-600" },
      { href: "/companies", label: "企業", icon: Building2, color: "text-yellow-600", activeBg: "bg-yellow-600" },
      { href: "/pm", label: "PM（受注管理）", icon: Clapperboard, color: "text-rose-600", activeBg: "bg-rose-600" },
      // 入金管理は admin 限定（Phase 9）。adminOnly フラグで非adminには非表示。
      { href: "/payments", label: "入金管理", icon: Wallet, color: "text-green-600", activeBg: "bg-green-600", adminOnly: true },
      // 京プロ 撮影会派遣はリージーの事業。tenants で会社を絞り、Luma・全社ビューには出さない。
      { href: "/kyopro", label: "京プロ", icon: Camera, color: "text-emerald-600", activeBg: "bg-emerald-600", tenants: ["reagey"] },
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
    { href: "/admin/agent-candidates", label: "リスト作成AI 候補", icon: ClipboardCheck, color: "text-indigo-500", activeBg: "bg-indigo-500" },
    { href: "/admin/industries", label: "業種", icon: Tag, color: "text-emerald-500", activeBg: "bg-emerald-500" },
    { href: "/admin/pipeline-stages", label: "商談プロセス", icon: GitBranch, color: "text-violet-500", activeBg: "bg-violet-500" },
    // T17: 見積テンプレート（FEATURE_QUOTE_PDF_V2 がONのときだけ表示）
    { href: "/admin/quote-templates", label: "見積テンプレート", icon: FileText, color: "text-amber-600", activeBg: "bg-amber-600", quoteV2Only: true },
    // T14: 見積書の発行者設定（社名・住所・ロゴ・採番・備考。見積テンプレートと同じく FEATURE_QUOTE_PDF_V2 がONのときだけ表示）
    { href: "/admin/quote-settings", label: "見積書の発行者設定", icon: FileCog, color: "text-amber-600", activeBg: "bg-amber-600", quoteV2Only: true },
    { href: "/admin/pm-staff", label: "PMスタッフ", icon: Users2, color: "text-rose-400", activeBg: "bg-rose-400" },
    { href: "/admin/users", label: "ユーザー権限", icon: Shield, color: "text-red-500", activeBg: "bg-red-500" },
    { href: "/admin/company-merges", label: "企業統合", icon: Merge, color: "text-teal-500", activeBg: "bg-teal-600" },
    { href: "/admin/trash", label: "ゴミ箱", icon: Trash2, color: "text-zinc-500", activeBg: "bg-zinc-700" },
  ],
};

/**
 * サイドバー最上部のブランド表示。選択中の会社タブで切り替わる。
 * 「いまどちらの会社を操作しているか」を常に目に入る位置で示し、誤起票を防ぐ。
 * Tailwind は動的クラス名を解決できないため静的な文字列で持つ。
 */
const BRAND: Record<
  string,
  { gradient: string; corporateName: string; title: string; subtitle: string; tagline: string }
> = {
  luma: {
    gradient: "from-orange-500 via-orange-500 to-amber-500",
    corporateName: "株式会社Luma",
    title: "Luma",
    subtitle: "Sales Agent",
    tagline: "受注を取りにいくAI",
  },
  reagey: {
    gradient: "from-emerald-700 via-emerald-600 to-teal-600",
    corporateName: "株式会社リージー",
    title: "Re;Easy",
    subtitle: "Sales Agent",
    tagline: "採用ブランディングの受注をつくる",
  },
  // 全社は2社の色を混ぜる（Luma のオレンジ → リージーの緑）
  [ALL_TENANTS_CODE]: {
    gradient: "from-orange-500 via-amber-500 to-emerald-600",
    corporateName: "全社ビュー（閲覧のみ）",
    title: "Luma",
    subtitle: "＋ Re;Easy",
    tagline: "2社合算の実績を見る",
  },
};

/**
 * 会社ごとの基調色。
 * ナビの色は Luma のブランドカラー（オレンジ〜アンバー〜イエロー）で組んであるので、
 * リージーを見ているときは対応する緑系に振り替えて画面全体を緑基調にする。
 * 機能ごとに割り当てた他の色（sky / pink / violet 等）はそのまま残す。
 */
const REAGEY_ACCENT: Record<string, string> = {
  "text-orange-500": "text-emerald-600",
  "bg-orange-500": "bg-emerald-600",
  "text-orange-600": "text-emerald-700",
  "bg-orange-600": "bg-emerald-700",
  "text-amber-500": "text-teal-500",
  "bg-amber-500": "bg-teal-500",
  "text-amber-600": "text-teal-600",
  "bg-amber-600": "bg-teal-600",
  "text-yellow-600": "text-green-600",
  "bg-yellow-600": "bg-green-600",
};

const accent = (cls: string, code: string) =>
  code === "reagey" ? (REAGEY_ACCENT[cls] ?? cls) : cls;

export function Sidebar({
  user,
  tenants = [],
  activeTenantCode = "luma",
  canViewAllTenants = false,
  quoteTemplatesEnabled = false,
}: {
  user: { name: string; email: string; avatarColor: string | null; avatarUrl?: string | null; permission: string } | null;
  tenants?: MyTenant[];
  activeTenantCode?: string;
  canViewAllTenants?: boolean;
  /** 見積テンプレート管理（T17）をメニューに出すか＝FEATURE_QUOTE_PDF_V2 の状態 */
  quoteTemplatesEnabled?: boolean;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();
  const brand = BRAND[activeTenantCode] ?? BRAND.luma;
  const isAdmin = user?.permission === "admin";
  // adminOnly のアイテム（入金管理など）は非adminには出さない。
  // tenants 指定のアイテム（京プロなど）は、その会社を見ているときだけ出す。
  const visibleBaseGroups = baseGroups.map((g) => ({
    ...g,
    items: g.items.filter((it) => {
      if ("adminOnly" in it && it.adminOnly && !isAdmin) return false;
      if ("tenants" in it && it.tenants && !it.tenants.includes(activeTenantCode)) return false;
      return true;
    }),
  }));
  // フラグOFFの機能（見積テンプレート）は管理者にもメニューに出さない
  const visibleAdminGroup = {
    ...adminGroup,
    items: adminGroup.items.filter((it) => !("quoteV2Only" in it && it.quoteV2Only) || quoteTemplatesEnabled),
  };
  const groups = isAdmin ? [...visibleBaseGroups, visibleAdminGroup] : visibleBaseGroups;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const sidebar = (
    <aside className="h-full w-72 shrink-0 border-r border-zinc-200 bg-gradient-to-b from-white to-zinc-50 flex flex-col">
      <div className={cn("px-5 py-5 border-b border-zinc-200 bg-gradient-to-br", brand.gradient)}>
        <div className="text-[10px] font-semibold tracking-widest text-white/80 uppercase mb-1.5">
          {brand.corporateName}
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-white/20 backdrop-blur p-2 shadow-lg">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-bold tracking-tight text-base text-white leading-tight">
              {brand.title}
              <span className="ml-1 text-white/90">{brand.subtitle}</span>
            </div>
            <div className="text-[10px] text-white/70 -mt-0.5">{brand.tagline}</div>
          </div>
        </div>
      </div>

      {/* 会社タブ（Luma / リージー / 全社）。所属が1社のみなら表示されない */}
      <TenantTabs tenants={tenants} activeCode={activeTenantCode} canViewAll={canViewAllTenants} />

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
                // 外部リンク（架電エージェント等）は別タブで開く
                if ("external" in it && it.external) {
                  return (
                    <a
                      key={it.href}
                      href={it.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-base transition-all text-zinc-700 hover:bg-zinc-100 font-medium"
                    >
                      <Icon className={cn("h-5 w-5", accent(it.color, activeTenantCode))} />
                      {it.label}
                      <ExternalLink className="h-3.5 w-3.5 text-zinc-400 ml-auto" />
                    </a>
                  );
                }
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-base transition-all",
                      active
                        ? `${accent(it.activeBg, activeTenantCode)} text-white shadow-md font-semibold`
                        : "text-zinc-700 hover:bg-zinc-100 font-medium",
                    )}
                  >
                    <Icon
                      className={cn("h-5 w-5", active ? "text-white" : accent(it.color, activeTenantCode))}
                    />
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
  // 狭い幅（md 未満）ではどのページでも常設サイドバーを隠し、左上のボタンから開くドロワーに切り替える。
  // md 以上は従来どおり常設（見た目は変えない）。以前は商談ページだけがこの切り替えの対象だった。
  return <>
    <div className="hidden shrink-0 md:block">{sidebar}</div>
    <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
      <DialogTrigger asChild>
        <button type="button" aria-label="ナビゲーションを開く" className="fixed left-3 top-4 z-40 rounded-md border border-zinc-200 bg-white p-2 md:hidden">
          <Menu className="h-5 w-5" />
        </button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="left-0 top-0 h-dvh w-72 max-w-[85vw] translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none p-0">
        <DialogTitle className="sr-only">ナビゲーション</DialogTitle>
        <div className="min-h-0 h-full" onClickCapture={event => {
          if ((event.target as HTMLElement).closest("a")) setMobileOpen(false);
        }}>{sidebar}</div>
      </DialogContent>
    </Dialog>
  </>;
}
