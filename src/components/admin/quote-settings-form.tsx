"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, Save, X } from "lucide-react";
import { isAcceptableLogoUrl, quoteNumber } from "@/lib/quote-issuer";
import { noteLines } from "@/lib/quote-notes";

/**
 * T14: 見積書の発行者設定フォーム（管理者画面）
 *
 * 保存は PATCH /api/admin/quote-settings。次の見積番号（開始番号）は、ここで書き換えたときだけ送る
 * （画面を開いている間に発行があると番号が進むため、触っていない値で上書きしない）。
 *
 * https のロゴは、保存時に API がサーバーから取得できるか確かめる。取れない新しい URL は 400 で理由が返り
 * （error に出す）、保存済みの URL が取れなくなっていたときは保存したうえで logoWarning が返る（注意として残す）。
 * 画面のプレビューで画像を読み込めないときも、壊れた画像のアイコンではなく案内を出す。
 */

export type QuoteSettingsValues = {
  legalName: string;
  postalCode: string;
  addressLine1: string;
  addressLine2: string;
  logoUrl: string | null;
  defaultNotes: string;
  travelExpenseNote: string | null;
  numberPrefix: string;
  nextQuoteNumber: number;
};

const INVALID_INPUT_MESSAGE =
  "入力内容を確認してください（社名・郵便番号・住所は必須。見積番号の接頭辞は英数字と - _ の12文字まで）";

export function QuoteSettingsForm({
  initial,
  saved,
  hasIssuedNumbers,
}: {
  initial: QuoteSettingsValues;
  saved: boolean;
  hasIssuedNumbers: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoWarning, setLogoWarning] = useState<string | null>(null);
  /** ブラウザでプレビューを読み込めなかったロゴの値（値を変えれば再び試す）。 */
  const [previewFailedFor, setPreviewFailedFor] = useState<string | null>(null);
  const [form, setForm] = useState(() => ({
    legalName: initial.legalName,
    postalCode: initial.postalCode,
    addressLine1: initial.addressLine1,
    addressLine2: initial.addressLine2,
    logoUrl: initial.logoUrl ?? "",
    defaultNotes: initial.defaultNotes,
    travelExpenseNote: initial.travelExpenseNote ?? "",
    numberPrefix: initial.numberPrefix,
    nextQuoteNumber: String(initial.nextQuoteNumber),
  }));
  const [nextTouched, setNextTouched] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /** 画像ファイルを data URL にしてロゴ欄へ入れる（外部URLを取りに行かずPDFへ埋め込める）。 */
  function pickLogo(file: File | undefined) {
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      setError("ロゴは PNG か JPEG の画像を選んでください");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      if (!isAcceptableLogoUrl(url)) {
        setError("ロゴの画像が大きすぎます（約290KBまで）");
        return;
      }
      setError(null);
      set("logoUrl", url);
    };
    reader.readAsDataURL(file);
  }

  const logo = form.logoUrl.trim();
  const logoValid = !logo || isAcceptableLogoUrl(logo);
  const next = Number(form.nextQuoteNumber);
  const nextValid = Number.isInteger(next) && next >= 1 && next <= 999_999;
  const prefixValid = /^[A-Za-z0-9_-]{1,12}$/.test(form.numberPrefix.trim());
  const exampleNumber = nextValid && prefixValid ? quoteNumber(form.numberPrefix.trim(), new Date(), next) : null;
  const standardCount = noteLines(form.defaultNotes).length;
  const travelCount = noteLines(form.travelExpenseNote).length;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!logoValid) { setError("ロゴは https のURLか PNG/JPEG の画像（約290KBまで）にしてください"); return; }
    if (!nextValid) { setError("次の見積番号は 1〜999999 の整数で入力してください"); return; }
    if (nextTouched && hasIssuedNumbers && next < initial.nextQuoteNumber) {
      setError(`発行済みの見積があるため、次の番号は現在の値（${initial.nextQuoteNumber}）より小さくできません`);
      return;
    }
    const payload = {
      legalName: form.legalName.trim(),
      postalCode: form.postalCode.trim(),
      addressLine1: form.addressLine1.trim(),
      addressLine2: form.addressLine2.trim(),
      logoUrl: logo || null,
      defaultNotes: noteLines(form.defaultNotes).join("\n"),
      travelExpenseNote: noteLines(form.travelExpenseNote).join("\n") || null,
      numberPrefix: form.numberPrefix.trim(),
      ...(nextTouched ? { nextQuoteNumber: next } : {}),
    };
    start(async () => {
      const r = await fetch("/api/admin/quote-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLogoWarning(null);
        setError(j.error === "Invalid input" ? INVALID_INPUT_MESSAGE : (j.error ?? "保存に失敗しました"));
        return;
      }
      setNextTouched(false);
      setError(null);
      setLogoWarning(typeof j.logoWarning === "string" && j.logoWarning ? j.logoWarning : null);
      setMsg("発行者設定を保存しました。これから発行・プレビューする見積書に反映されます");
      setTimeout(() => setMsg(null), 4000);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6 text-[15px]">
      {!saved && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          まだ保存されていません。表示しているのは初期値（最初の見積発行時に自動で作られる内容）です。
        </p>
      )}
      {msg && <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}
      {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {logoWarning && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{logoWarning}</p>}

      <section className="rounded-lg border border-zinc-200 bg-white p-6 space-y-4">
        <p className="font-semibold text-zinc-900">発行者（見積書の右上）</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="quote-settings-legal-name">社名</Label>
            <Input id="quote-settings-legal-name" value={form.legalName} onChange={(e) => set("legalName", e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="quote-settings-postal">郵便番号</Label>
            <Input id="quote-settings-postal" value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} placeholder="170-0013" className="w-40" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="quote-settings-address1">住所（1行目）</Label>
            <Input id="quote-settings-address1" value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} placeholder="東京都豊島区東池袋" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="quote-settings-address2">住所（2行目）</Label>
            <Input id="quote-settings-address2" value={form.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} placeholder="2-7-3 柄澤ビル3F" required />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm" htmlFor="quote-settings-logo">ロゴ（任意）</Label>
          <div className="flex items-center gap-3 flex-wrap">
            <Input
              id="quote-settings-logo"
              value={logo.startsWith("data:") ? "（画像ファイルを設定済み）" : form.logoUrl}
              readOnly={logo.startsWith("data:")}
              onChange={(e) => set("logoUrl", e.target.value)}
              placeholder="https://… または画像ファイルを選択"
              className="flex-1 min-w-[16rem]"
            />
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-900 hover:bg-zinc-50">
              <ImagePlus className="h-4 w-4" /> 画像を選ぶ
              <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {logo && (
              <Button type="button" variant="ghost" size="sm" onClick={() => set("logoUrl", "")}>
                <X className="h-4 w-4" /> ロゴを外す
              </Button>
            )}
          </div>
          <p className="text-xs text-zinc-500">PNG か JPEG（約290KBまで）。PDFでは社名の上に幅100pt・高さ24ptに収めて表示します。赤い印影は出しません。https のURLは、保存するときにサーバーから取得できるかを確かめます。</p>
          {logo && logoValid && previewFailedFor !== logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt="ロゴのプレビュー"
              onError={() => setPreviewFailedFor(logo)}
              className="mt-1 max-h-12 max-w-[200px] object-contain rounded border border-zinc-200 bg-white p-1"
            />
          )}
          {logo && logoValid && previewFailedFor === logo && (
            <p role="status" className="text-xs text-amber-800">
              この画像を読み込めませんでした。URL が正しいか、画像が公開されているかを確かめてください。取得できないロゴのままでは、見積書はロゴなしで発行されます。
            </p>
          )}
          {logo && !logoValid && <p className="text-xs text-red-600">https のURLか PNG/JPEG の画像にしてください</p>}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 space-y-4">
        <p className="font-semibold text-zinc-900">見積番号</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="quote-settings-prefix">接頭辞</Label>
            <Input id="quote-settings-prefix" value={form.numberPrefix} onChange={(e) => set("numberPrefix", e.target.value)} className="w-32" required />
            <p className="text-xs text-zinc-500">英数字と - _ の12文字まで。</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="quote-settings-next">次の番号（開始番号）</Label>
            <Input
              id="quote-settings-next"
              type="number"
              min={hasIssuedNumbers ? initial.nextQuoteNumber : 1}
              max={999999}
              value={form.nextQuoteNumber}
              onChange={(e) => { set("nextQuoteNumber", e.target.value); setNextTouched(true); }}
              className="w-32"
              required
            />
            <p className="text-xs text-zinc-500">
              {hasIssuedNumbers ? `発行済みの見積があるため、現在の値（${initial.nextQuoteNumber}）より小さくはできません。` : "まだ番号を使った見積はありません。"}
            </p>
          </div>
        </div>
        <p className="text-sm text-zinc-600">
          次に発行する見積書の番号：<span className="font-mono">{exampleNumber ?? "—"}</span>（日付は発行日）
        </p>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 space-y-4">
        <p className="font-semibold text-zinc-900">備考の文面</p>
        <div className="space-y-1.5">
          <Label className="text-sm" htmlFor="quote-settings-notes">標準備考（1行＝1項目。新規見積では既定で入れる）</Label>
          <Textarea id="quote-settings-notes" value={form.defaultNotes} onChange={(e) => set("defaultNotes", e.target.value)} rows={3} />
          <p className="text-xs text-zinc-500">{standardCount} 行。見積作成画面の「標準備考を入れる」でまとめて外せます。</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm" htmlFor="quote-settings-travel">交通費備考の選択肢（1行＝選択肢1つ）</Label>
          <Textarea id="quote-settings-travel" value={form.travelExpenseNote} onChange={(e) => set("travelExpenseNote", e.target.value)} rows={3} />
          <p className="text-xs text-zinc-500">{travelCount} 種類。見積作成画面で1つ選ぶか「入れない」を選びます（既定は入れない）。</p>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          <Save className="h-4 w-4" /> 保存する
        </Button>
      </div>
    </form>
  );
}
