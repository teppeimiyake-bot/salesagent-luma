"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CompanyLogo } from "@/components/ui/company-logo";
import {
  Building2,
  Briefcase,
  Trash2,
  RotateCcw,
  AlertTriangle,
  Loader2,
  Package,
  Calendar,
} from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import type { DealStatus } from "@prisma/client";

type TrashedCompany = {
  id: string;
  name: string;
  industry: string | null;
  logoUrl: string | null;
  logoColor: string | null;
  // Prisma返却の `Date | null` を許容（実際は WHERE で not null してるので非null）
  deletedAt: string | Date | null;
  _count: { deals: number; contacts: number };
};

type TrashedDeal = {
  id: string;
  title: string;
  status: DealStatus;
  deletedAt: string | Date | null;
  company: {
    id: string;
    name: string;
    logoUrl: string | null;
    logoColor: string | null;
    deletedAt: string | Date | null;
  };
  owner: { id: string; name: string; avatarColor: string | null } | null;
  products: Array<{
    id: string;
    productName: string;
    planName: string | null;
    probability: number;
    amount: number | null;
    yomiStatus: string | null;
  }>;
  _count: { tasks: number; meetings: number };
};

interface Props {
  companies: TrashedCompany[];
  deals: TrashedDeal[];
}

function formatDateTime(d: Date | string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TrashList({ companies, deals }: Props) {
  return (
    <Tabs defaultValue="companies" className="w-full">
      <TabsList className="grid w-full grid-cols-2 max-w-md h-11">
        <TabsTrigger value="companies" className="text-sm">
          <Building2 className="h-4 w-4 mr-1.5" />
          企業 ({companies.length})
        </TabsTrigger>
        <TabsTrigger value="deals" className="text-sm">
          <Briefcase className="h-4 w-4 mr-1.5" />
          商談 ({deals.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="companies" className="mt-4 space-y-3">
        {companies.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center text-base text-zinc-500">
              ゴミ箱に企業はありません。
            </CardContent>
          </Card>
        ) : (
          companies.map((c) => <CompanyRow key={c.id} company={c} />)
        )}
      </TabsContent>

      <TabsContent value="deals" className="mt-4 space-y-3">
        {deals.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center text-base text-zinc-500">
              ゴミ箱に商談はありません。
            </CardContent>
          </Card>
        ) : (
          deals.map((d) => <DealRow key={d.id} deal={d} />)
        )}
      </TabsContent>
    </Tabs>
  );
}

function CompanyRow({ company }: { company: TrashedCompany }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [permanentOpen, setPermanentOpen] = useState(false);

  function restore() {
    setError(null);
    start(async () => {
      const r = await fetch(`/api/companies/${company.id}/restore`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "復元に失敗しました");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="border-zinc-200">
      <CardContent className="p-5">
        <div className="grid grid-cols-12 gap-4 items-center">
          <div className="col-span-12 md:col-span-6 flex items-start gap-3 min-w-0">
            <CompanyLogo
              name={company.name}
              logoUrl={company.logoUrl}
              logoColor={company.logoColor}
              size="md"
            />
            <div className="min-w-0">
              <p className="font-bold text-lg text-zinc-700 line-through decoration-zinc-300">
                {company.name}
              </p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {company.industry && (
                  <Badge variant="outline" className="text-xs">
                    {company.industry}
                  </Badge>
                )}
                <Badge variant="secondary" className="text-xs">
                  商談 {company._count.deals} 件
                </Badge>
                <Badge variant="secondary" className="text-xs">
                  連絡先 {company._count.contacts} 件
                </Badge>
              </div>
              <p className="text-xs text-zinc-500 mt-2 inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                削除日時: {formatDateTime(company.deletedAt)}
              </p>
            </div>
          </div>

          <div className="col-span-12 md:col-span-6 flex md:justify-end items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="primary"
              onClick={restore}
              disabled={pending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              復元
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setPermanentOpen(true)}
              disabled={pending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              完全削除
            </Button>
          </div>
        </div>
        {error && (
          <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
            {error}
          </p>
        )}
      </CardContent>

      <PermanentDeleteDialog
        open={permanentOpen}
        onOpenChange={setPermanentOpen}
        endpoint={`/api/companies/${company.id}?permanent=true`}
        targetLabel={company.name}
        cascadeNote={`連絡先 ${company._count.contacts} 件、商談 ${company._count.deals} 件、および商談に紐づく議事録・タスク・ドキュメント等が全て物理削除されます。`}
      />
    </Card>
  );
}

function DealRow({ deal }: { deal: TrashedDeal }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [permanentOpen, setPermanentOpen] = useState(false);

  const parentDeleted = !!deal.company.deletedAt;

  function restore() {
    setError(null);
    start(async () => {
      const r = await fetch(`/api/deals/${deal.id}/restore`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "復元に失敗しました");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="border-zinc-200">
      <CardContent className="p-5">
        <div className="grid grid-cols-12 gap-4 items-center">
          <div className="col-span-12 md:col-span-7 flex items-start gap-3 min-w-0">
            <CompanyLogo
              name={deal.company.name}
              logoUrl={deal.company.logoUrl}
              logoColor={deal.company.logoColor}
              size="md"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-base text-zinc-700 line-through decoration-zinc-300">
                  {deal.company.name}
                </span>
                <Badge variant={statusColor(deal.status)} className="opacity-70">
                  {STATUS_LABEL[deal.status]}
                </Badge>
              </div>
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                <Package className="h-3.5 w-3.5 text-green-500 shrink-0" />
                {deal.products.length === 0 ? (
                  <span className="text-xs text-zinc-400">プロダクトなし</span>
                ) : (
                  <>
                    {deal.products.slice(0, 3).map((p) => (
                      <Badge key={p.id} variant="outline" className="text-xs">
                        {p.productName}
                      </Badge>
                    ))}
                    {deal.products.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        +{deal.products.length - 3}
                      </Badge>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-2 inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                削除日時: {formatDateTime(deal.deletedAt)}
              </p>
              {parentDeleted && (
                <p className="text-xs text-amber-700 mt-1 inline-flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded">
                  <AlertTriangle className="h-3 w-3" />
                  親企業も削除済み（先に企業を復元してください）
                </p>
              )}
            </div>
          </div>

          <div className="col-span-6 md:col-span-2 text-right md:text-left">
            <p className="text-xs text-zinc-500 mb-0.5">提案額合計</p>
            <p className="font-bold text-base tabular-nums">
              {formatJPY(deal.products.reduce((s, p) => s + (p.amount ?? 0), 0))}
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              {deal._count.meetings} MTG / {deal._count.tasks} ToDo
            </p>
          </div>

          <div className="col-span-6 md:col-span-3 flex md:justify-end items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="primary"
              onClick={restore}
              disabled={pending || parentDeleted}
              title={parentDeleted ? "親企業の復元が必要" : ""}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-zinc-300"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              復元
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setPermanentOpen(true)}
              disabled={pending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              完全削除
            </Button>
          </div>
        </div>
        {error && (
          <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
            {error}
          </p>
        )}
      </CardContent>

      <PermanentDeleteDialog
        open={permanentOpen}
        onOpenChange={setPermanentOpen}
        endpoint={`/api/deals/${deal.id}?permanent=true`}
        targetLabel={`${deal.company.name} ／ ${deal.title}`}
        cascadeNote={`議事録 ${deal._count.meetings} 件、ToDo ${deal._count.tasks} 件、AIログ・ドキュメント等が全て物理削除されます。`}
      />
    </Card>
  );
}

function PermanentDeleteDialog({
  open,
  onOpenChange,
  endpoint,
  targetLabel,
  cascadeNote,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  endpoint: string;
  targetLabel: string;
  cascadeNote: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function execute() {
    setError(null);
    start(async () => {
      const r = await fetch(endpoint, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "削除に失敗しました");
        return;
      }
      onOpenChange(false);
      setConfirmText("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" />
            完全削除しますか？
          </DialogTitle>
          <DialogDescription className="pt-1 text-base text-zinc-700">
            <span className="font-semibold text-zinc-900">{targetLabel}</span>{" "}
            を物理削除します。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-red-50 border border-red-300 p-3 text-sm text-red-900">
          <p className="font-bold mb-1 inline-flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            この操作は取り消せません
          </p>
          <p>{cascadeNote}</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700">
            実行するには <span className="font-mono text-red-600">削除</span> と入力してください
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="w-full h-9 rounded-md border border-zinc-300 px-3 text-base focus:outline-none focus:ring-2 focus:ring-red-500"
            placeholder="削除"
          />
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              setConfirmText("");
              setError(null);
            }}
            disabled={pending}
          >
            キャンセル
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={execute}
            disabled={pending || confirmText !== "削除"}
          >
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                削除中...
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                完全に削除する
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
