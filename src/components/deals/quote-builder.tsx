"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sparkles, Plus, Trash2, Download, FileCheck2, Pencil, Wand2, Eye, CopyPlus, BookmarkPlus, CornerDownRight } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { calculateQuote, type QuoteTaxCategory } from "@/lib/quote-calculation";
import { buildQuoteChains, quoteRevisionLabel } from "@/lib/quote-version";
import { templateLinesToQuoteLines } from "@/lib/quote-template";
import {
  composeQuoteNote, initialNoteSelection, quoteNotePresets, splitQuoteNote,
  type QuoteNotePresets, type QuoteNoteSelection,
} from "@/lib/quote-notes";

type DealProductLite = {
  id: string;
  productName: string;
  planName: string | null;
  planProposals: string[];
  amount: number | null;
};

type QuoteLine = { name: string; detail?: string | null; qty: number; unitPrice: number; unit: string; taxCategory: QuoteTaxCategory; taxRate: number };
type QuoteTemplate = {
  id: string;
  name: string;
  productId?: string | null;
  planName?: string | null;
  sortOrder?: number;
  lines: QuoteLine[];
};

/** T14: 画面内プレビューに出す発行者（/api/admin/quote-settings/defaults） */
type IssuerPreview = { legalName: string; postalCode: string; addressLine1: string; addressLine2: string; logoUrl: string | null };

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
  issueDate: string | Date;
  quoteNumber?: string | null;
  subtotal?: number | null;
  taxTotal?: number | null;
  grandTotal?: number | null;
  lines: QuoteLine[];
  dealProduct?: { id: string; productName: string; planName: string | null } | null;
  // T17: 改訂チェーン（発行済み→改訂版）を一覧でつなげて見せるために使う
  supersedesQuoteId?: string | null;
  finalizedAt?: string | Date | null;
  supersedes?: { id: string; quoteNumber: string | null; version: string | null } | null;
};

function lineTotal(l: QuoteLine) {
  return l.qty * l.unitPrice;
}

function parseOptionalYen(raw: string): number {
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function calc(lines: QuoteLine[], taxRate: number) {
  if (lines.every((line) => line.taxCategory && Number.isInteger(line.taxRate))) {
    const totals = calculateQuote(lines);
    return { subtotal: totals.subtotal, tax: totals.taxTotal, total: totals.grandTotal, nonTaxable: totals.nonTaxableBase };
  }
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0); const tax = Math.floor((subtotal * taxRate) / 100);
  return { subtotal, tax, total: subtotal + tax, nonTaxable: 0 };
}
const fmt = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/**
 * 見積書 自動作成（機能①）。
 *   - DealProduct（プラン/企画案）単位で複数作成可。
 *   - 金額サジェスト（同一カテゴリ×プラン×企画案の過去実績中央値→basePrice）。手修正可。
 *   - 確定で見積書PDFを生成し Document(category=quote) に格納＋ダウンロード可能。
 */
/** 発行できたときの案内。ロゴを取得できずロゴなしで発行したときは、その旨（finalize の logoWarning）も出す。 */
function issuedMessage(result: { logoWarning?: unknown }) {
  return typeof result.logoWarning === "string" && result.logoWarning
    ? `✓ 見積書PDFを発行しました。${result.logoWarning}`
    : "✓ 見積書PDFを発行しました";
}

export function QuoteBuilder({
  dealId,
  companyName,
  dealProducts,
  canEdit,
  featureV2,
}: {
  dealId: string;
  companyName: string;
  dealProducts: DealProductLite[];
  canEdit: boolean;
  featureV2: boolean;
}) {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 発行・保存・改訂の送信中の印。同じイベント内の2回目のクリックは、再描画前で disabled がまだ効かないため、
  // Meet発行（meetInFlight）と同じく ref で止める。
  const submitInFlight = useRef(false);
  const [templates, setTemplates] = useState<QuoteTemplate[]>([]);
  // T17: テンプレート適用の確認（window.confirm は自動操作をブロックするため画面内で確認する）
  const [pendingTemplateId, setPendingTemplateId] = useState<string>("");
  // T17: 「テンプレートとして保存」ダイアログ
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");

  // フォーム状態
  const [dealProductId, setDealProductId] = useState<string | "">("");
  // T17: プラン/企画案で明細を置き換える前の確認（テンプレート適用と同じく画面内で確認する）
  const [pendingProductId, setPendingProductId] = useState<string>("");
  const [clientName, setClientName] = useState(companyName);
  const [honorific, setHonorific] = useState("御中");
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  // T14 AC-07: 備考は発行者設定の標準備考（既定ON）＋交通費備考（選択式）＋自由記述で組み立てる。
  // 文面は設定から読み、読めるまで・読めないときはサンプル見積書の文面を使う。
  const [issuer, setIssuer] = useState<IssuerPreview | null | undefined>(undefined); // undefined=読み込み中
  const [notePresets, setNotePresets] = useState<QuoteNotePresets>(() => quoteNotePresets(null));
  const [noteSelection, setNoteSelection] = useState<QuoteNoteSelection>(initialNoteSelection);
  const [canManageSettings, setCanManageSettings] = useState(false);
  const [taxRate, setTaxRate] = useState(10);
  const [version, setVersion] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date()));
  const blankLine = (): QuoteLine => ({ name: "", detail: "", qty: 1, unitPrice: 0, unit: "式", taxCategory: "taxable", taxRate: 10 });
  /**
   * T17: プラン/企画案・テンプレートで明細を置き換える前の「入力あり」判定。
   * 初期の空行（blankLine）と1項目でも違う行があれば入力ありとみなす。品目名・単価だけでなく、
   * 補足・数量・単位・税区分だけを変えた行も黙って消さないため。
   * 比べるのは空行が持つ項目だけなので、保存済み明細に付いてくる id などは見ない。
   * 文字列は前後の空白を無視し、補足の null / 未設定は空文字と同じに扱う。
   */
  function hasEnteredLines(ls: QuoteLine[]): boolean {
    const blank = blankLine();
    const fields = Object.keys(blank) as (keyof QuoteLine)[];
    const normalize = (value: QuoteLine[keyof QuoteLine]) => (typeof value === "string" ? value.trim() : value ?? "");
    return ls.some((line) => fields.some((field) => normalize(line[field]) !== normalize(blank[field])));
  }
  const [lines, setLines] = useState<QuoteLine[]>([blankLine()]);
  const noteText = featureV2 ? composeQuoteNote(notePresets, noteSelection) : note.trim();

  async function load() {
    const quotesRequest = fetch(`/api/deals/${dealId}/quotes`);
    if (featureV2) {
      // 編集・改訂では保存済みの備考をプリセットに分解するので、見積一覧より先に反映する
      const sr = await fetch("/api/admin/quote-settings/defaults").catch(() => null);
      const sj = sr?.ok ? await sr.json().catch(() => null) : null;
      setIssuer(sj?.issuer ?? null);
      if (sj?.notes) setNotePresets(sj.notes);
      setCanManageSettings(!!sj?.canManage);
    }
    const r = await quotesRequest;
    const j = await r.json();
    setQuotes(j.quotes ?? []);
    if (featureV2) {
      const tr = await fetch("/api/quote-templates");
      const tj = await tr.json();
      setTemplates(tj.templates ?? []);
    }
  }
  useEffect(() => {
    // 初期表示・商談切替時にAPIの見積履歴とテンプレートへ同期する。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  function resetForm() {
    setDealProductId("");
    setPendingProductId("");
    setPendingTemplateId("");
    setClientName(companyName);
    setHonorific("御中");
    setSubject("");
    setNote("");
    setNoteSelection(initialNoteSelection());
    setTaxRate(10);
    setVersion("");
    setIssueDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date()));
    setLines([blankLine()]);
    setEditingId(null);
  }

  function startNew() {
    resetForm();
    setOpen(true);
  }

  function startEdit(q: Quote) {
    setEditingId(q.id);
    setDealProductId(q.dealProduct?.id ?? "");
    setPendingProductId("");
    setPendingTemplateId("");
    setClientName(q.clientName);
    setHonorific(q.clientHonorific);
    setSubject(q.subject ?? "");
    setNote(q.note ?? "");
    setNoteSelection(splitQuoteNote(q.note, notePresets));
    setTaxRate(q.taxRate);
    setVersion(q.version ?? "");
    setIssueDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(q.issueDate)));
    setLines(q.lines.length ? q.lines.map((l) => ({ ...l, unit: l.unit ?? "式", taxCategory: l.taxCategory ?? "taxable", taxRate: l.taxRate ?? q.taxRate })) : [blankLine()]);
    setOpen(true);
  }

  /**
   * T17: プラン/企画案の選択。選ぶと明細を提案内容で置き換えるため、
   * 入力済みの明細があるときはテンプレート適用と同じく画面内で確認を挟む（やめたら明細も選択も元のまま）。
   */
  function onPickProduct(id: string) {
    if (dealProducts.some((d) => d.id === id) && hasEnteredLines(lines)) {
      setPendingProductId(id);
      return;
    }
    return commitProduct(id);
  }

  // DealProduct を選んだら品目名・サジェスト金額を自動セット
  async function commitProduct(id: string) {
    setPendingProductId("");
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
      setLines([{ name: itemName || dp.productName, detail: dp.planProposals?.join("・") || "", qty: 1, unitPrice: suggested, unit: "式", taxCategory: "taxable", taxRate: 10 }]);
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
    setLines((ls) => [...ls, blankLine()]);
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));
  }

  /** 入力中の内容を下書きとして保存し、見積IDを返す（失敗時は null）。T17 のテンプレート化から使う。 */
  async function persistDraft(): Promise<string | null> {
    const cleanLines = buildCleanLines();
    if (cleanLines.length === 0) { setMsg("品目を1行以上入力してください"); return null; }
    const payload = {
      dealProductId: dealProductId || null,
      clientName: clientName.trim() || companyName,
      clientHonorific: honorific,
      subject: subject.trim() || null,
      note: noteText || null,
      taxRate,
      version: version.trim() || null,
      issueDate,
      lines: cleanLines,
    };
    if (editingId) {
      const r = await fetch(`/api/quotes/${editingId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!r.ok) { setMsg("保存に失敗しました"); return null; }
      return editingId;
    }
    const r = await fetch(`/api/deals/${dealId}/quotes`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(j.error ?? "保存に失敗しました"); return null; }
    setEditingId(j.quote.id);
    return j.quote.id as string;
  }

  function buildCleanLines() {
    return lines
      .filter((l) => l.name.trim())
      .map((l) => ({ name: l.name.trim(), detail: l.detail?.trim() || null, qty: Math.max(1, l.qty), unitPrice: Math.max(0, Math.round(l.unitPrice)), unit: l.unit.trim() || "式", taxCategory: l.taxCategory, taxRate: l.taxCategory === "non_taxable" ? 0 : l.taxRate }));
  }

  async function save(finalize: boolean) {
    const cleanLines = lines
      .filter((l) => l.name.trim())
      .map((l) => ({ name: l.name.trim(), detail: l.detail?.trim() || null, qty: Math.max(1, l.qty), unitPrice: Math.max(0, Math.round(l.unitPrice)), unit: l.unit.trim() || "式", taxCategory: l.taxCategory, taxRate: l.taxCategory === "non_taxable" ? 0 : l.taxRate }));
    if (cleanLines.length === 0) {
      setMsg("品目を1行以上入力してください");
      return;
    }
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setBusy(true);
    try {
      const payload = {
        dealProductId: dealProductId || null,
        clientName: clientName.trim() || companyName,
        clientHonorific: honorific,
        subject: subject.trim() || null,
        note: noteText || null,
        taxRate,
        version: version.trim() || null,
        issueDate,
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
        const fr = await fetch(`/api/quotes/${quoteId}/finalize`, { method: "POST", headers: featureV2 ? { "Idempotency-Key": crypto.randomUUID() } : undefined });
        const fj = await fr.json();
        if (!fr.ok) { setMsg(fj.error ?? "PDF生成に失敗しました"); setBusy(false); await load(); return; }
        setMsg(issuedMessage(fj));
      } else {
        setMsg("✓ 下書きを保存しました");
      }
      setOpen(false);
      resetForm();
      await load();
      router.refresh();
      // ロゴなしで発行したときの案内は読めるよう長めに残す
      setTimeout(() => setMsg(null), finalize ? 10_000 : 3500);
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  }

  async function finalizeExisting(id: string) {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setBusy(true);
    try {
      const r = await fetch(`/api/quotes/${id}/finalize`, { method: "POST", headers: featureV2 ? { "Idempotency-Key": crypto.randomUUID() } : undefined });
      const j = await r.json();
      setMsg(r.ok ? issuedMessage(j) : (j.error ?? "PDF生成に失敗しました"));
      await load();
      router.refresh();
      setTimeout(() => setMsg(null), r.ok && j.logoWarning ? 10_000 : 3500);
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  }

  async function revise(id: string) {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setBusy(true);
    try {
      const r = await fetch(`/api/quotes/${id}/revise`, { method: "POST" }); const j = await r.json();
      if (!r.ok) { setMsg(j.error ?? "改訂版を作成できませんでした"); return; }
      await load(); startEdit(j.quote); setMsg("改訂用の下書きを作成しました");
    } finally { submitInFlight.current = false; setBusy(false); }
  }

  async function openPreview(id: string) {
    const r = await fetch(`/api/quotes/${id}/preview`, { method: "POST" });
    if (!r.ok) { const j = await r.json(); setMsg(j.error ?? "プレビューを生成できませんでした"); return; }
    const logoWarning = r.headers.get("X-Quote-Logo-Warning");
    if (logoWarning) { setMsg(decodeURIComponent(logoWarning)); setTimeout(() => setMsg(null), 10_000); }
    const url = URL.createObjectURL(await r.blob()); window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /**
   * T17: テンプレート適用。
   * 入力済みの明細を黙って上書きしないよう、中身があるときは画面内で確認を挟む。
   * 明細はテンプレート固有のフィールド（id / templateId / tenantId / sortOrder）を落として取り込む。
   */
  function applyTemplate(id: string) {
    if (!id) { setPendingTemplateId(""); return; }
    const template = templates.find((item) => item.id === id);
    if (!template?.lines.length) return;
    if (hasEnteredLines(lines)) {
      setPendingTemplateId(id);
      return;
    }
    commitTemplate(id);
  }

  function commitTemplate(id: string) {
    const template = templates.find((item) => item.id === id);
    if (!template?.lines.length) return;
    setLines(templateLinesToQuoteLines(template.lines));
    setPendingTemplateId("");
    setMsg(`テンプレート「${template.name}」の明細を反映しました`);
    setTimeout(() => setMsg(null), 3500);
  }

  /**
   * T17: いまの明細をテンプレートとして登録する。
   * 未保存の新規見積の場合は、先に下書きとして保存してからテンプレート化する
   * （テンプレート化APIは保存済みの見積明細を読むため）。
   */
  async function saveAsTemplate() {
    const name = templateName.trim();
    if (!name) { setMsg("テンプレート名を入力してください"); return; }
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setBusy(true);
    try {
      // 未保存の新規見積でも、編集中の既存見積でも、いったん下書きとして保存してからテンプレート化する
      const quoteId = await persistDraft();
      if (!quoteId) return;
      const r = await fetch(`/api/quotes/${quoteId}/save-as-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, productId: null, planName: null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(j.error ?? "テンプレートを保存できませんでした"); return; }
      setSaveTemplateOpen(false);
      setMsg(`✓ テンプレート「${name}」を保存しました`);
      await load();
      setTimeout(() => setMsg(null), 3500);
    } finally {
      submitInFlight.current = false;
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
  const pendingProduct = dealProducts.find((d) => d.id === pendingProductId);

  // T17: supersedesQuoteId を辿って改訂チェーンにまとめる（一覧は createdAt desc で来る）
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const chains = buildQuoteChains(
    quotes.map((q) => ({
      id: q.id,
      version: q.version,
      quoteNumber: q.quoteNumber ?? null,
      status: q.status,
      supersedesQuoteId: q.supersedesQuoteId ?? null,
    })),
  );

  /** 見積1件の行。isRevision のときは「旧版」として控えめに描く。 */
  function renderQuoteRow(q: Quote, isRevision: boolean) {
    const t = calc(q.lines, q.taxRate);
    const parent = q.supersedesQuoteId ? quoteById.get(q.supersedesQuoteId) : null;
    const label = quoteRevisionLabel(q.version, parent?.quoteNumber ?? q.supersedes?.quoteNumber ?? null);
    const isFinal = q.status === "final";
    const hasActions = !!q.documentId || canEdit;
    return (
      // 狭い画面では操作ボタンを本文の下の行に回す（1行に並べると本文の幅が数文字まで潰れて1文字ずつ折り返すため）。
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={isRevision ? "shrink-0 text-zinc-300" : "rounded-md bg-amber-50 p-2 shrink-0"}>
            {isRevision ? <CornerDownRight className="h-4 w-4" /> : <Sparkles className="h-4 w-4 text-amber-600" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className={isRevision ? "text-[13px] text-zinc-600 truncate" : "text-sm font-medium truncate"}>{q.clientName} {q.clientHonorific}</p>
              {q.quoteNumber && <Badge variant="info" className="text-[12px]">{q.quoteNumber}</Badge>}
              {label && <Badge variant="outline" className="text-[12px]">{label}</Badge>}
              <Badge variant={isFinal ? "success" : "secondary"} className="text-[12px]">
                {isFinal ? "発行済み" : "下書き"}
              </Badge>
            </div>
            <p className="text-[12.5px] text-zinc-400">
              {q.subject ? `${q.subject}／` : ""}合計 {fmt(t.total)}（税込）／ {formatDate(q.createdAt)}
            </p>
            {featureV2 && isFinal && canEdit && !isRevision && (
              <p className="text-[12px] text-zinc-400 mt-0.5">発行済みの見積は上書きせず、改訂版として新しく作成します</p>
            )}
          </div>
        </div>
        {hasActions && (
          <div className="flex items-center gap-3 flex-wrap pl-11 sm:pl-0 sm:flex-nowrap sm:shrink-0">
            {/* 発行済みPDFはいつでも取り出せるよう残す（T14の方針） */}
            {q.documentId && (
              <a href={`/api/documents/${q.documentId}/download`} className="text-sm text-orange-600 hover:underline inline-flex items-center gap-1 shrink-0">
                <Download className="h-3.5 w-3.5" /> PDF
              </a>
            )}
            {canEdit && (
              <>
                {(!featureV2 || !isFinal) && (
                  <Button
                    type="button" variant="outline" size="sm" className="shrink-0"
                    onClick={() => startEdit(q)} title="この見積を修正する" aria-label="この見積を修正する"
                  >
                    <Pencil className="h-3.5 w-3.5" /> 編集
                  </Button>
                )}
                {featureV2 && !isFinal && (
                  <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => openPreview(q.id)} title="PDFプレビュー" aria-label="PDFプレビュー">
                    <Eye className="h-3.5 w-3.5" /> プレビュー
                  </Button>
                )}
                {featureV2 && isFinal && (
                  <Button
                    type="button" variant="outline" size="sm" className="shrink-0"
                    onClick={() => revise(q.id)} disabled={busy} title="改訂版を作成する" aria-label="改訂版を作成する"
                  >
                    <CopyPlus className="h-3.5 w-3.5" /> 改訂版を作成
                  </Button>
                )}
                {!isFinal && (
                  <button onClick={() => finalizeExisting(q.id)} disabled={busy} className="text-zinc-300 hover:text-orange-600 shrink-0" title="確定してPDF発行" aria-label="確定してPDF発行">
                    <Wand2 className="h-4 w-4" />
                  </button>
                )}
                {(!featureV2 || !isFinal) && (
                  <button onClick={() => remove(q.id)} className="text-zinc-300 hover:text-red-500 shrink-0" title="削除" aria-label="削除">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-zinc-100 p-1.5 text-zinc-500">
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
        {msg && <p className="text-[13px] text-amber-700 bg-amber-50 px-3 py-2 rounded mb-3">{msg}</p>}

        {open && canEdit && (
          <div className="space-y-3 mb-4 p-4 rounded-lg border border-amber-200 bg-white">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {featureV2 && templates.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-sm">明細テンプレート</Label>
                  {/*
                    T17: 選択は pendingTemplateId で制御する。確認中だけ選んだテンプレート名を出し、
                    「置き換える」「やめる」のどちらでも「（テンプレートを選択）」に戻す
                    （非制御だと「やめる」後も名前が残って適用済みに見え、同じテンプレートを選び直しても change が起きない）。
                  */}
                  <select value={pendingTemplateId} onChange={(e) => applyTemplate(e.target.value)} aria-label="明細テンプレート" className="w-full h-9 rounded-md border border-zinc-300 px-2 text-sm">
                    <option value="">（テンプレートを選択）</option>
                    {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </select>
                  {/* T17: 入力済みの明細を上書きする前の確認（ブロッキングダイアログは使わない） */}
                  {pendingTemplateId && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                      <p>入力中の明細をテンプレートの内容で置き換えます。よろしいですか？</p>
                      <div className="mt-1.5 flex gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => commitTemplate(pendingTemplateId)}>置き換える</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setPendingTemplateId("")}>やめる</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
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
                <p className="text-[12px] text-zinc-400">選ぶと過去実績の中央値で単価をサジェストします（手修正可）。</p>
                {/* T17: 入力済みの明細をプラン/企画案の内容で上書きする前の確認（ブロッキングダイアログは使わない） */}
                {pendingProductId && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                    <p>
                      入力中の明細を「{pendingProduct ? [pendingProduct.productName, pendingProduct.planName].filter(Boolean).join(" / ") : ""}」の内容で置き換えます。よろしいですか？
                    </p>
                    <div className="mt-1.5 flex gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => commitProduct(pendingProductId)}>置き換える</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setPendingProductId("")}>やめる</Button>
                    </div>
                  </div>
                )}
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
                <Label className="text-sm">{featureV2 ? "発行日" : "バージョン（任意）"}</Label>
                {featureV2 ? <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /> : <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="例: v2 / 値引き案" />}
              </div>
            </div>

            {/* 明細 */}
            <div className="space-y-2">
              <Label className="text-sm">明細</Label>
              <div className="space-y-2">
                {/*
                  T14: 明細1行を「品目・補足」の段と「数量・単位・単価・税区分・金額」の段に分ける。
                  12分割グリッドの1列（右に要約欄が出る1440px幅では約40px）に数量・単位を入れると、
                  入力欄の左右余白と数値のスピンボタンで値が見えなくなるため、数値欄には固定の最小幅を持たせ、
                  入り切らない幅（390px など）では折り返す。ビューポートではなくカードの幅で決まるよう flex-wrap で組む。
                */}
                {lines.map((l, i) => (
                  <div key={i} className="rounded-md border border-zinc-200 p-2 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <Input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} placeholder="品目" aria-label="品目" className="min-w-[12rem] flex-[2_1_12rem]" />
                      <Input value={l.detail ?? ""} onChange={(e) => setLine(i, { detail: e.target.value })} placeholder="補足（任意）" aria-label="補足" className="min-w-[10rem] flex-[1_1_10rem] text-[13px]" />
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="w-20 shrink-0 space-y-0.5">
                        <span className="block text-[11px] text-zinc-500">数量</span>
                        <Input type="number" min={1} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder="数量" className="px-2" />
                      </label>
                      {featureV2 && (
                        <label className="w-20 shrink-0 space-y-0.5">
                          <span className="block text-[11px] text-zinc-500">単位</span>
                          <Input value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} placeholder="単位" className="px-2" />
                        </label>
                      )}
                      <label className="min-w-[9rem] flex-1 space-y-0.5">
                        <span className="block text-[11px] text-zinc-500">単価（税抜）</span>
                        <Input
                          type="number"
                          min={0}
                          value={l.unitPrice === 0 ? "" : l.unitPrice}
                          onChange={(e) => setLine(i, { unitPrice: parseOptionalYen(e.target.value) })}
                          placeholder="単価(税抜)"
                          className="px-2"
                        />
                      </label>
                      {featureV2 && (
                        <label className="w-28 shrink-0 space-y-0.5">
                          <span className="block text-[11px] text-zinc-500">税区分</span>
                          <select value={l.taxCategory} onChange={(e) => setLine(i, { taxCategory: e.target.value as QuoteTaxCategory, taxRate: e.target.value === "non_taxable" ? 0 : 10 })} className="w-full h-9 rounded-md border border-zinc-300 px-1 text-[13px]"><option value="taxable">課税10%</option><option value="non_taxable">不課税</option></select>
                        </label>
                      )}
                      <div className="ml-auto flex h-9 items-center justify-end gap-1">
                        <span className="text-[13px] text-zinc-500 whitespace-nowrap">{fmt(lineTotal(l))}</span>
                        <button type="button" onClick={() => removeLine(i)} className="text-zinc-300 hover:text-red-500" title="行を削除" aria-label="行を削除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" /> 明細を追加
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              {!featureV2 && <div className="flex items-center gap-2">
                <Label className="text-sm">消費税率</Label>
                <Input type="number" min={0} max={100} value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} className="w-20" />
                <span className="text-sm">%</span>
              </div>}
              <div className="text-sm text-right">
                <div>小計 {fmt(totals.subtotal)}　消費税 {fmt(totals.tax)}</div>
                {featureV2 && totals.nonTaxable > 0 && <div>不課税対象 {fmt(totals.nonTaxable)}</div>}
                <div className="font-bold text-amber-700">合計 {fmt(totals.total)}（税込）</div>
              </div>
            </div>

            {featureV2 ? (
              <div className="space-y-2">
                <Label className="text-sm">備考</Label>
                {notePresets.standard.length > 0 && (
                  <label className="flex items-start gap-2 text-sm text-zinc-700">
                    <input
                      type="checkbox" className="mt-1 h-4 w-4 accent-orange-500"
                      checked={noteSelection.standard}
                      onChange={(e) => setNoteSelection((s) => ({ ...s, standard: e.target.checked }))}
                    />
                    <span>
                      標準備考を入れる
                      <span className="block whitespace-pre-wrap text-[12.5px] text-zinc-500">{notePresets.standard.join("\n")}</span>
                    </span>
                  </label>
                )}
                {notePresets.travel.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-[13px] text-zinc-600" htmlFor="quote-travel-note">交通費備考</Label>
                    <select
                      id="quote-travel-note"
                      value={noteSelection.travelIndex ?? ""}
                      onChange={(e) => setNoteSelection((s) => ({ ...s, travelIndex: e.target.value === "" ? null : Number(e.target.value) }))}
                      className="w-full h-9 rounded-md border border-zinc-300 px-2 text-sm"
                    >
                      <option value="">入れない</option>
                      {notePresets.travel.map((text, index) => <option key={index} value={index}>{text}</option>)}
                    </select>
                  </div>
                )}
                <textarea
                  value={noteSelection.extra} onChange={(e) => setNoteSelection((s) => ({ ...s, extra: e.target.value }))}
                  placeholder="その他の備考（任意）" rows={2} aria-label="その他の備考"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
                {canManageSettings && (
                  <p className="text-[12px] text-zinc-400">
                    文面と発行者は <a href="/admin/quote-settings" className="text-orange-600 hover:underline">見積書の発行者設定</a> で変更できます（管理者）
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <Label className="text-sm">備考（任意）</Label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 見積有効期限 発行から30日" rows={1} className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
              </div>
            )}

            {featureV2 && <div className="mx-auto w-full max-w-md aspect-[210/297] rounded border bg-white shadow-sm p-5 text-[9px] text-zinc-600 overflow-hidden">
              <p className="text-center text-base font-bold tracking-[0.3em] text-zinc-900">見 積 書</p>
              <div className="mt-5 flex justify-between"><p className="font-bold border-b">{clientName.replace(/(?:御中|様)\s*$/, "")} {honorific}</p>
                {/* T14: 発行者は直書きせず発行者設定（PDFと同じ値）を出す */}
                <p className="text-right">
                  {issuer?.logoUrl && /^(?:https:|data:image\/)/.test(issuer.logoUrl) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={issuer.logoUrl} alt="" className="ml-auto mb-0.5 max-h-5 max-w-[80px] object-contain" />
                  )}
                  {issuer ? <>{issuer.legalName}<br />〒{issuer.postalCode}<br />{issuer.addressLine1}<br />{issuer.addressLine2}</> : issuer === undefined ? "発行者設定を読み込み中…" : "（発行者設定を読み込めませんでした）"}
                  <br />発行日：{issueDate.replaceAll("-", "/")}
                </p>
              </div>
              <p className="mt-4 border-b py-2 text-sm font-bold text-zinc-900">御見積金額 {fmt(totals.total)}（税込）</p>
              <div className="mt-3 border"><div className="grid grid-cols-[3fr_1fr_1fr_1fr_1.5fr] bg-zinc-100 font-bold"><span>品目</span><span>単価</span><span>数量</span><span>単位</span><span>価格</span></div>{lines.slice(0, 5).map((line, index) => <div key={index} className="grid grid-cols-[3fr_1fr_1fr_1fr_1.5fr] border-t"><span>{line.name}<small className="block">{line.detail}</small></span><span>{line.unitPrice.toLocaleString()}</span><span>{line.qty}</span><span>{line.unit}</span><span>{lineTotal(line).toLocaleString()}</span></div>)}</div>
              <p className="mt-3 whitespace-pre-wrap">備考<br />{noteText}</p><p className="mt-4 text-center">1 / 1</p>
            </div>}

            <div className="flex justify-end gap-2 pt-1 flex-wrap">
              {/* T17: この明細をそのままテンプレート化できるようにする（管理画面に行かずに作れる） */}
              {featureV2 && lines.some((l) => l.name.trim()) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setTemplateName(subject.trim() || lines.find((l) => l.name.trim())?.name.trim() || ""); setSaveTemplateOpen(true); }}
                  disabled={busy}
                  title="いまの明細を次回以降使えるテンプレートとして保存します"
                >
                  <BookmarkPlus className="h-3.5 w-3.5" /> テンプレートとして保存
                </Button>
              )}
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
            {chains.map((chain) => {
              // T17: 最新版を主行、旧版をその下にぶら下げて「同じ見積の改訂の連なり」として見せる。
              const nodes = chain.nodes.map((n) => quoteById.get(n.id)!).filter(Boolean);
              const latest = nodes[nodes.length - 1];
              const older = nodes.slice(0, -1).reverse();
              return (
                <li key={chain.rootId} className="py-3">
                  {renderQuoteRow(latest, false)}
                  {older.length > 0 && (
                    <ul className="mt-2 ml-6 border-l border-zinc-200 pl-4 space-y-2">
                      {older.map((q) => (
                        <li key={q.id}>{renderQuoteRow(q, true)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* T17: テンプレート名を聞くダイアログ */}
        <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>テンプレートとして保存</DialogTitle>
              <DialogDescription>
                いまの明細を次回以降の見積で選べるテンプレートにします。既存のテンプレートは書き換えません。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label className="text-sm">テンプレート名</Label>
              <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="例: 採用動画 スタンダード一式" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setSaveTemplateOpen(false)}>キャンセル</Button>
              <Button variant="primary" size="sm" onClick={saveAsTemplate} disabled={busy || !templateName.trim()}>
                <BookmarkPlus className="h-3.5 w-3.5" /> 保存する
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
