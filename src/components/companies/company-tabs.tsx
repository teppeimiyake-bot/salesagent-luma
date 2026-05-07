"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Globe,
  Users,
  Briefcase,
  FileText,
  Plus,
  Trash2,
  Sparkles,
  Mail,
  Phone,
  Crown,
  RefreshCw,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { formatJPY, formatDate } from "@/lib/utils";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import { ProbabilityBadge } from "@/components/ui/probability-badge";
import { NewDealDialog } from "@/components/deals/new-deal-dialog";
import {
  pipelineAmount as calcPipelineAmount,
  totalProposedAmount,
  weightedProbability,
  yomiColor,
  type DealProductLite,
} from "@/lib/deal-aggregations";
import { stripYomiPrefix } from "@/lib/yomi-status";
import type { DealStatus } from "@prisma/client";

type Contact = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  note: string | null;
};

type DealProduct = DealProductLite & {
  id: string;
  yomiStatus: string | null;
  owner?: { id: string; name: string; avatarColor: string | null } | null;
};

type Deal = {
  id: string;
  title: string;
  status: DealStatus;
  nextAction: string | null;
  nextActionAt: Date | string | null;
  owner: { id: string; name: string; avatarColor: string | null } | null;
  products: DealProduct[];
};

export function CompanyTabs({
  company,
}: {
  company: {
    id: string;
    name: string;
    websiteUrl: string | null;
    websiteSummary: string | null;
    websiteFetchedAt: Date | string | null;
    contacts: Contact[];
    deals: Deal[];
  };
}) {
  const router = useRouter();
  const [fetching, setFetching] = useState(false);

  async function fetchSummary() {
    setFetching(true);
    await fetch(`/api/companies/${company.id}/fetch-summary`, { method: "POST" });
    setFetching(false);
    router.refresh();
  }

  const activeDeals = company.deals.filter((d) => d.status !== "WON" && d.status !== "LOST");

  return (
    <Tabs defaultValue="deals" className="w-full">
      <TabsList className="grid w-full grid-cols-4 max-w-2xl h-11">
        <TabsTrigger value="deals" className="text-sm">
          <Briefcase className="h-4 w-4 mr-1.5" />
          商談 ({company.deals.length})
        </TabsTrigger>
        <TabsTrigger value="proposals" className="text-sm">
          <FileText className="h-4 w-4 mr-1.5" />
          提案内容 ({activeDeals.length})
        </TabsTrigger>
        <TabsTrigger value="contacts" className="text-sm">
          <Users className="h-4 w-4 mr-1.5" />
          連絡先 ({company.contacts.length})
        </TabsTrigger>
        <TabsTrigger value="research" className="text-sm">
          <Globe className="h-4 w-4 mr-1.5" />
          リサーチ
        </TabsTrigger>
      </TabsList>

      {/* 商談 */}
      <TabsContent value="deals" className="space-y-3 mt-4">
        <div className="flex justify-end">
          <NewDealDialog defaultCompanyId={company.id} />
        </div>
        {company.deals.map((d) => {
          const totalAmt = totalProposedAmount(d.products);
          const probability = weightedProbability(d.products);
          const productNames = d.products.slice(0, 3).map((p) => p.productName);
          const restCount = Math.max(0, d.products.length - 3);
          return (
            <Link key={d.id} href={`/deals/${d.id}`} className="block group">
              <Card className="hover:shadow-md hover:border-emerald-300 transition-all">
                <CardContent className="p-5">
                  <div className="grid grid-cols-12 gap-4 items-center">
                    <div className="col-span-12 md:col-span-7">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <Badge variant={statusColor(d.status)}>{STATUS_LABEL[d.status]}</Badge>
                        <span className="font-bold text-lg group-hover:text-emerald-700">
                          {d.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 flex-wrap mt-1">
                        {productNames.map((name, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {name}
                          </Badge>
                        ))}
                        {restCount > 0 && (
                          <Badge variant="secondary" className="text-xs">
                            +{restCount}
                          </Badge>
                        )}
                      </div>
                      {d.nextAction && (
                        <p className="text-sm text-zinc-700 mt-2">
                          <span className="text-zinc-400">Next: </span>
                          {d.nextAction}
                          {d.nextActionAt && (
                            <span className="ml-2 text-amber-600 font-medium">
                              {formatDate(d.nextActionAt)}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <p className="text-xs text-zinc-500 mb-0.5">提案額合計</p>
                      <p className="text-lg font-bold tabular-nums">{formatJPY(totalAmt)}</p>
                    </div>
                    <div className="col-span-6 md:col-span-2 flex justify-center">
                      <ProbabilityBadge value={probability} size="md" />
                    </div>
                    <div className="hidden md:flex col-span-1 justify-center">
                      {d.owner && (
                        <div
                          className="w-9 h-9 rounded-full text-white text-sm font-bold flex items-center justify-center shadow-sm"
                          style={{ background: d.owner.avatarColor ?? "#6366f1" }}
                          title={d.owner.name}
                        >
                          {d.owner.name.charAt(0)}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {company.deals.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center text-base text-zinc-500">
              この企業の商談はまだありません。
            </CardContent>
          </Card>
        )}
      </TabsContent>

      {/* 提案内容（DealProduct単位で1カードずつ表示） */}
      <TabsContent value="proposals" className="space-y-3 mt-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-600">提案中のプロダクト一覧（見込み金額表示）</p>
          <NewDealDialog defaultCompanyId={company.id} />
        </div>
        {(() => {
          const activeProducts = activeDeals.flatMap((d) =>
            d.products.map((p) => ({ ...p, dealId: d.id, dealStatus: d.status })),
          );
          if (activeProducts.length === 0) {
            return (
              <Card>
                <CardContent className="p-12 text-center text-base text-zinc-500">
                  提案中のプロダクトはありません。
                </CardContent>
              </Card>
            );
          }
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {activeProducts.map((p) => {
                const yc = yomiColor(p.yomiStatus);
                return (
                  <Card key={p.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-lg truncate">{p.productName}</p>
                          {p.planName && (
                            <Badge variant="info" className="text-xs mt-1">
                              {p.planName}
                            </Badge>
                          )}
                          {p.yomiStatus && (
                            <span
                              className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${yc.bg} ${yc.text} ${yc.border} ml-1`}
                              title={p.yomiStatus}
                            >
                              {stripYomiPrefix(p.yomiStatus)}
                            </span>
                          )}
                        </div>
                        <ProbabilityBadge value={p.probability} size="lg" />
                      </div>
                      <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-zinc-100">
                        <div>
                          <p className="text-xs text-zinc-500">提案額</p>
                          <p className="text-xl font-bold tabular-nums">{formatJPY(p.amount)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-500">見込み金額</p>
                          <p className="text-xl font-bold tabular-nums text-emerald-700">
                            {formatJPY(calcPipelineAmount([p]))}
                          </p>
                        </div>
                      </div>
                      <Link
                        href={`/deals/${p.dealId}`}
                        className="mt-4 inline-block text-sm font-medium text-emerald-600 hover:underline"
                      >
                        商談詳細を見る →
                      </Link>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          );
        })()}
      </TabsContent>

      {/* 連絡先 */}
      <TabsContent value="contacts" className="space-y-3 mt-4">
        <ContactsList
          companyId={company.id}
          contacts={company.contacts}
          onChange={() => router.refresh()}
        />
      </TabsContent>

      {/* リサーチ（HP） */}
      <TabsContent value="research" className="space-y-4 mt-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-emerald-600" />
                Webサイト調査
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={fetchSummary}
                disabled={fetching || !company.websiteUrl}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {fetching ? "AI要約中..." : "AI再要約"}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {company.websiteSummary ? (
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-5">
                <pre className="whitespace-pre-wrap text-sm text-zinc-700 leading-relaxed font-sans">
                  {company.websiteSummary}
                </pre>
                {company.websiteFetchedAt && (
                  <p className="text-xs text-zinc-400 mt-3 inline-flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" />
                    最終取得 {formatDate(company.websiteFetchedAt)}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 text-center py-6">
                ヒーローセクションでHP URLを設定し、「AI要約」を押すとサイトを取得し事業概要・最新ニュース・営業着眼点をAIが抽出します。
              </p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function ContactsList({
  companyId,
  contacts,
  onChange,
}: {
  companyId: string;
  contacts: Contact[];
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [isDecisionMaker, setIsDM] = useState(false);
  const [saving, setSaving] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, name, role, email, phone, note, isDecisionMaker }),
    });
    setSaving(false);
    setName("");
    setRole("");
    setEmail("");
    setPhone("");
    setNote("");
    setIsDM(false);
    setAdding(false);
    onChange();
  }

  async function remove(id: string) {
    if (!confirm("削除しますか？")) return;
    await fetch(`/api/contacts/${id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <>
      <div className="flex justify-end">
        {!adding && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            連絡先を追加
          </Button>
        )}
      </div>
      {adding && (
        <Card>
          <CardContent className="p-5">
            <form onSubmit={add} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-sm">氏名</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div className="space-y-1">
                  <Label className="text-sm">役職</Label>
                  <Input value={role} onChange={(e) => setRole(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-sm">メール</Label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-sm">電話</Label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-sm">メモ</Label>
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isDecisionMaker}
                  onChange={(e) => setIsDM(e.target.checked)}
                />
                決裁者
              </label>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  キャンセル
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={saving || !name}>
                  {saving ? "保存中..." : "追加"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {contacts.length === 0 && !adding && (
        <Card>
          <CardContent className="p-12 text-center text-base text-zinc-500">
            連絡先が登録されていません。
          </CardContent>
        </Card>
      )}
      {contacts.map((c) => (
        <ContactCard key={c.id} contact={c} onChange={onChange} onRemove={() => remove(c.id)} />
      ))}
    </>
  );
}

function ContactCard({
  contact,
  onChange,
  onRemove,
}: {
  contact: Contact;
  onChange: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name);
  const [role, setRole] = useState(contact.role ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [isDecisionMaker, setIsDM] = useState(contact.isDecisionMaker);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setName(contact.name);
    setRole(contact.role ?? "");
    setEmail(contact.email ?? "");
    setPhone(contact.phone ?? "");
    setIsDM(contact.isDecisionMaker);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  async function save() {
    if (!name.trim()) {
      setError("氏名は必須です");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("メールアドレスの形式が不正です");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        role: role.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        isDecisionMaker,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(j.error || "更新に失敗しました");
      return;
    }
    setEditing(false);
    onChange();
  }

  if (editing) {
    return (
      <Card className="ring-1 ring-emerald-300 bg-emerald-50/30">
        <CardContent className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">氏名</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">役職</Label>
              <Input value={role} onChange={(e) => setRole(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">メール</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">電話</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDecisionMaker}
              onChange={(e) => setIsDM(e.target.checked)}
            />
            決裁者
          </label>
          {error && (
            <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
              <X className="h-4 w-4 mr-1" />
              キャンセル
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={save} disabled={saving}>
              <Check className="h-4 w-4 mr-1" />
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="hover:shadow-sm transition-shadow group">
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-lg shadow-sm shrink-0"
            style={{ background: contact.isDecisionMaker ? "#f59e0b" : "#6366f1" }}
          >
            {contact.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-lg">{contact.name}</span>
              {contact.isDecisionMaker && (
                <Badge variant="warning">
                  <Crown className="h-3 w-3 mr-1" />
                  決裁者
                </Badge>
              )}
              {contact.isPrimary && <Badge variant="info">主担当</Badge>}
            </div>
            {contact.role && <p className="text-sm text-zinc-600 mt-0.5">{contact.role}</p>}
            <div className="flex flex-wrap gap-4 mt-3 text-sm text-zinc-700">
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="inline-flex items-center gap-1.5 hover:text-emerald-600"
                >
                  <Mail className="h-3.5 w-3.5" />
                  {contact.email}
                </a>
              )}
              {contact.phone && (
                <a
                  href={`tel:${contact.phone}`}
                  className="inline-flex items-center gap-1.5 hover:text-emerald-600"
                >
                  <Phone className="h-3.5 w-3.5" />
                  {contact.phone}
                </a>
              )}
            </div>
            {contact.note && <p className="text-sm text-zinc-500 mt-3">{contact.note}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={startEdit}
              className="text-zinc-300 hover:text-emerald-600 opacity-0 group-hover:opacity-100 transition-opacity p-1"
              title="編集"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={onRemove}
              className="text-zinc-300 hover:text-red-500 p-1"
              title="削除"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
