"use client";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DocumentUploadDialog } from "@/components/documents/document-upload-dialog";
import { BookOpen, FileSignature, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "knowledge" | "contract" | "proposal";

const TABS: { key: Tab; label: string; icon: typeof BookOpen; color: string; activeBg: string }[] = [
  {
    key: "knowledge",
    label: "ナレッジ",
    icon: BookOpen,
    color: "text-amber-600",
    activeBg: "bg-gradient-to-br from-amber-500 to-orange-500",
  },
  {
    key: "contract",
    label: "契約書",
    icon: FileSignature,
    color: "text-red-600",
    activeBg: "bg-gradient-to-br from-red-500 to-rose-500",
  },
  {
    key: "proposal",
    label: "提案書",
    icon: FileText,
    color: "text-emerald-600",
    activeBg: "bg-gradient-to-br from-orange-500 to-amber-500",
  },
];

export function DocumentsTabs({
  tab,
  counts,
  permission,
}: {
  tab: Tab;
  counts: Record<Tab, number>;
  permission: string;
}) {
  // タブごとにアップロード可能か / 既定カテゴリを決定
  const canUploadCurrent =
    tab === "contract" ? permission === "admin" : permission !== "viewer";
  const defaultCategoryForTab: Record<Tab, string> = {
    knowledge: "case_study",
    contract: "contract",
    proposal: "proposal",
  };
  // contractタブは contract のみ、それ以外は通常の選択肢を許す
  const allowedCategories: Record<Tab, string[]> = {
    knowledge: ["case_study", "template", "other"],
    contract: ["contract"],
    proposal: ["proposal"],
  };

  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="inline-flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1.5 shadow-sm">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={`/documents?tab=${t.key}`}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
                active
                  ? `${t.activeBg} text-white shadow`
                  : "text-zinc-700 hover:bg-zinc-50",
              )}
            >
              <Icon className={cn("h-4 w-4", active ? "text-white" : t.color)} />
              {t.label}
              <Badge
                variant={active ? "secondary" : "outline"}
                className={cn(
                  "ml-1 text-[10px]",
                  active && "bg-white/30 text-white border-white/40",
                )}
              >
                {counts[t.key]}
              </Badge>
            </Link>
          );
        })}
      </div>

      {canUploadCurrent && (
        <DocumentUploadDialog
          defaultCategory={defaultCategoryForTab[tab]}
          allowedCategories={allowedCategories[tab]}
          isContract={tab === "contract"}
        />
      )}
      {!canUploadCurrent && tab === "contract" && permission !== "admin" && (
        <p className="text-xs text-zinc-500">契約書は管理者のみアップロード可能</p>
      )}
    </div>
  );
}
