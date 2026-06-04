"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Plus, Trash2, Download, FileCheck2, Pencil, Wand2 } from "lucide-react";
import { formatDate } from "@/lib/utils";

type DealProductLite = {
  id: string;
  productName: string;
  planName: string | null;
  planProposals: string[];
  amount: number | null;
};

type QuoteLine = { name: string; detail?: string | null; qty: number; unitPrice: number };

type Quote = {
  id: string;
  clientName: string;
  clientHonorific: string;
  subject: string | null;
  note: string | null;
  taxRate: number;
  version: string | null;
  status: string;
  documentId: string | null;
  createdAt: string | Date;
  lines: QuoteLine[];
  dealProduct?: { id: string; productName: string; planName: string | null } | null;
};

function lineTotal(l: QuoteLine) {
  return l.qty * l.unitPrice;
}
function calc(lines: QuoteLine[], taxRate: number) {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const tax = Math.floor((subtotal * taxRate) / 100);
  return { subtotal, tax, total: subtotal + tax };
}
const fmt = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/**
 * 見積書 自動作成（機能①）。
 *   - DealProduct（プラン/企画案）単位で複数作成可。
 *   - 金額サジェスト（同一カテゴリ×プラン×企画案の過去実績中央値→basePrice）。手修正可。
 *   - 確定で見積書PDFを生成し Document(category=quote) に格納＋ダウンロード可能。
 */
export function QuoteBuilder({
  dealId,
  companyName,
  dealProducts,
  canEdit,
}: {
  dealId: string;
  companyName: string;
  dealProducts: DealProductLite[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // フォーム状態
  const [dealProductId, setDealProductId] = useState<string | "">("");
  const [clientName, setClientName] = useState(companyName);
  const [honorific, setHonorific] = useState("御中");
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [taxRate, setTaxRate] = useState(10);
  const [version, setVersion] = useState("");
  const [lines, setLines] = useState<QuoteLine[]>([{ name: "", detail: "", qty: 1, unitPrice: 0 }]);

  async function load() {
    const r = await fetch(`/api/deals/${dealId}/quotes`);
    const j = await r.json();
    setQuotes(j.quotes ?? []);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  function resetForm() {
    setDealProductId("");
    setClientName(companyName);
    setHonorific("御中");
    setSubject("");
    setNote("");
    setTaxRate(10);
    setVersion("");
    setLines([{ name: "", detail: "", qty: 1, unitPrice: 0 }]);
    setEditingId(null);
  }

  function startNew() {
    resetForm();
    setOpen(true);
  }

  function startEdit(q: Quote) {
    setEditingId(q.id);
    setDealProductId(q.dealProduct?.id ?? "");
    setClientName(q.clientName);
    setHonorific(q.clientHonorific);
    setSubject(q.subject ?? "");
    setNote(q.note ?? "");
    setTaxRate(q.taxRate);
    setVersion(q.version ?? "");
    setLines(q.lines.length ? q.lines.map((l) => ({ ...l })) : [{ name: "", detail: "", qty: 1, unitPrice: 0 }]);
    setOpen(true);
  }

  // DealProduct を選んだら品目名・サジェスト金額を自動セット
  async function onPickProduct(id: string) {
    setDealProductId(id);
    const dp = dealProducts.find((d) => d.id === id);
    if (!dp) return;
    const itemName = [dp.productName, dp.planName].filter(Boolean).join(" / ");
    if (!subject) setSubject(itemName);
    setBusy(true);
    try {
      const r = await fetch("/api/quotes/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealProductId: id }),
      });
      const j = await r.json();
      const suggested = typeof j.amount === "number" ? j.amount : dp.amount ?? 0;
      setLines([{ name: itemName || dp.productName, detail: dp.planProposals?.join("・") || "", qty: 1, unitPrice: suggested }]);
      if (j.source === "median") setMsg(`過去${j.sampleSize}件の中央値で単価をサジェストしました`);
      else if (j.source === "basePrice") setMsg("プランのベース価格で単価をサジェストしました");
      else setMsg("過去実績が無いため単価は0です。手入力してください");
      setTimeout(() => setMsg(null), 3500);
    } finally {
      setBusy(false);
    }
  }

  function setLine(i: number, patch: Partial<QuoteLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, { name: "", detail: "", qty: 1, unitPrice: 0 }]);
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));
  }

  async function save(finalize: boolean) {
    const cleanLines = lines
      .filter((l) => l.name.trim())
      .map((l) => ({ name: l.name.trim(), detail: l.detail?.trim() || null, qty: Math.max(1, l.qty), unitPrice: Math.max(0, Math.round(l.unitPrice)) }));
    if (cleanLines.length === 0) {
      setMsg("品目を1行以上入力してください");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        dealProductId: dealProductId || null,
        clientName: clientName.trim() || companyName,
        clientHonorific: honorific,
        subject: subject.trim() || null,
        note: note.trim() || null,
        taxRate,
        version: version.trim() || null,
        lines: cleanLines,
      };
      let quoteId = editingId;
      if (editingId) {
        const r = await fetch(`/api/quotes/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) { setMsg("保存に失敗しました"); setBusy(false); return; }
      } else {
        const r = await fetch(`/api/deals/${dealId}/quotes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (!r.ok) { setMsg(j.error ?? "保存に失敗しました"); setBusy(false); return; }
        quoteId = j.quote.id;
      }
      if (finalize && quoteId) {
        const fr = await fetch(`/api/quotes/${quoteId}/finalize`, { method: "POST" });
        const fj = await fr.json();
        if (!fr.ok) { setMsg(fj.error ?? "PDF生成に失敗しました"); setBusy(false); await load(); return; }
        setMsg("✓ 見積書PDFを発行しました");
      } else {
        setMsg("✓ 下書きを保存しました");
      }
      setOpen(false);
      resetForm();
      await load();
      router.refresh();
      setTimeout(() => setMsg(null), 3500);
    } finally {
      setBusy(false);
    }
  }

  async function finalizeExisting(id: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/quotes/${id}/finalize`, { method: "POST" });
      const j = await r.json();
      setMsg(r.ok ? "✓ 見積書PDFを発行しました" : (j.error ?? "PDF生成に失敗しました"));
      await load();
      router.refresh();
      setTimeout(() => setMsg(null), 3500);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("この見積を削除しますか？（発行済みPDFも削除されます）")) return;
    await fetch(`/api/quotes/${id}`, { method: "DELETE" });
    await load();
    router.refresh();
  }

  const totals = calc(lines, taxRate);

  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50/40 via-white to-sky-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-indigo-500 to-sky-500 text-white p-1.5 shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            見積書 自動作成
            <Badge variant="secondary">{quotes.length}件</Badge>
          </span>
          {canEdit && (
            <Button size="sm" variant="primary" onClick={startNew} disabled={busy}>
              <Plus className="h-3.5 w-3.5" /> 新規作成
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {msg && <p className="text-xs text-indigo-700 bg-indigo-50 px-3 py-2 rounded mb-3">{msg}</p>}

        {open && canEdit && (
          <div className="space-y-3 mb-4 p-4 rounded-lg border border-indigo-200 bg-white">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-sm">プラン/企画案（DealProduct）から作成</Label>
                <select
                  value={dealProductId}
                  onChange={(e) => onPickProduct(e.target.value)}
                  className="w-full h-9 rounded-md border border-zinc-300 px-2 text-sm"
                >
                  <option value="">（手動で組む）</option>
                  {dealProducts.map((dp) => (
                    <option key={dp.id} value={dp.id}>
                      {[dp.productName, dp.planName].filter(Boolean).join(" / ")}
                      {dp.amount ? `（¥${dp.amount.toLocaleString("ja-JP")}）` : ""}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-zinc-400">選ぶと過去実績の中央値で単価をサジェストします（手修正可）。</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1">
                  <Label className="text-sm">宛名</Label>
                  <Input value={clientName} onChange={(e) => setClientName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-sm">敬称</Label>
                  <select value={honorific} onChange={(e) => setHonorific(e.target.value)} className="w-full h-9 rounded-md border border-zinc-300 px-2 text-sm">
                    <option value="御中">御中</option>
                    <option value="様">様</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2 space-y-1">
                <Label className="text-sm">委託業務名（件名）</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="例: 採用動画制作一式" />
              </div>
              <div className="space-y-1">
                <Label className="text-sm">バージョン（任意）</Label>
                <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="例: v2 / 値引き案" />
              </div>
            </div>

            {/* 明細 */}
            <div className="space-y-2">
              <Label className="text-sm">明細</Label>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-5">
                      <Input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} placeholder="品目" />
                      <Input value={l.detail ?? ""} onChange={(e) => setLine(i, { detail: e.target.value })} placeholder="補足（任意）" className="mt-1 text-xs" />
                    </div>
                    <div className="col-span-2">
                      <Input type="number" min={1} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder="数量" />
                    </div>
                    <div className="col-span-3">
                      <Input type="number" min={0} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} placeholder="単価(税抜)" />
                    </div>
                    <div className="col-span-2 flex items-center justify-end gap-1 pt-2">
                      <span className="text-xs text-zinc-500">{fmt(lineTotal(l))}</span>
                      <button onClick={() => removeLine(i)} className="text-zinc-300 hover:text-red-500" title="行を削除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" /> 明細を追加
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-sm">消費税率</Label>
                <Input type="number" min={0} max={100} value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} className="w-20" />
                <span className="text-sm">%</span>
              </div>
              <div className="text-sm text-right">
                <div>小計 {fmt(totals.subtotal)}　消費税 {fmt(totals.tax)}</div>
                <div className="font-bold text-indigo-700">合計 {fmt(totals.total)}（税込）</div>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-sm">備考（任意）</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 見積有効期限 発行から30日" />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => { setOpen(false); resetForm(); }}>キャンセル</Button>
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={busy}>
                下書き保存
              </Button>
              <Button variant="primary" size="sm" onClick={() => save(true)} disabled={busy}>
                <FileCheck2 className="h-3.5 w-3.5" /> 確定してPDF発行
              </Button>
            </div>
          </div>
        )}

        {quotes.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-4">
            自動作成の見積はまだありません。{canEdit ? "「新規作成」から作成できます。" : ""}
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {quotes.map((q) => {
              const t = calc(q.lines, q.taxRate);
              return (
                <li key={q.id} className="py-3 flex items-center gap-3">
                  <div className="rounded-md bg-indigo-50 p-2 shrink-0">
                    <Sparkles className="h-4 w-4 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-sm font-medium truncate">{q.clientName} {q.clientHonorific}</p>
                      {q.version && <Badge variant="info" className="text-[10px]">{q.version}</Badge>}
                      <Badge variant={q.status === "final" ? "success" : "secondary"} className="text-[10px]">
                        {q.status === "final" ? "発行済み" : "下書き"}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-zinc-400">
                      {q.subject ? `${q.subject}／` : ""}合計 {fmt(t.total)}（税込）／ {formatDate(q.createdAt)}
                    </p>
                  </div>
                  {q.documentId && (
                    <a href={`/api/documents/${q.documentId}/download`} className="text-sm text-emerald-600 hover:underline inline-flex items-center gap-1 shrink-0">
                      <Download className="h-3.5 w-3.5" /> PDF
                    </a>
                  )}
                  {canEdit && (
                    <>
                      <button onClick={() => startEdit(q)} className="text-zinc-300 hover:text-indigo-600 shrink-0" title="編集">
                        <Pencil className="h-4 w-4" />
                      </button>
                      {q.status !== "final" && (
                        <button onClick={() => finalizeExisting(q.id)} disabled={busy} className="text-zinc-300 hover:text-emerald-600 shrink-0" title="確定してPDF発行">
                          <Wand2 className="h-4 w-4" />
                        </button>
                      )}
                      <button onClick={() => remove(q.id)} className="text-zinc-300 hover:text-red-500 shrink-0" title="削除">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
