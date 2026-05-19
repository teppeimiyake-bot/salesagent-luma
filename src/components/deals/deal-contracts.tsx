"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FileSignature, Upload, Download, Trash2, ExternalLink, Link2, FileText } from "lucide-react";
import { formatDate } from "@/lib/utils";

type Doc = {
  id: string;
  name: string;
  description: string | null;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  category: string;
  version: string | null;
  sourceType?: string;
  createdAt: Date | string;
};

/** ファイル名から拡張子を除いた文字列を返す */
function stripExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

/**
 * 商談ごとの「個別契約書」セクション。
 *
 * deal-documents.tsx（提案書・見積書）と同じ仕組み・UIパターンを踏襲しつつ、
 * カテゴリは contract 固定（scope="deal" / dealId 紐付け）で保存する。
 * 全商談で常時表示（ステータス問わず）。
 *
 * 提案書側との違い:
 *   - 種別セレクトは無し（contract 固定）
 *   - ファイルを選ぶとファイル名（拡張子除去）がドキュメント名へ自動入力される
 */
export function DealContracts({ dealId, companyName }: { dealId: string; companyName?: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState(false);
  // 登録モード：file = アップロード / url = 外部リンク
  const [mode, setMode] = useState<"file" | "url">("file");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const urlAutoName = companyName ? `${companyName} 個別契約書` : "個別契約書";

  function resetForm() {
    setMode("file");
    setName("");
    setNameTouched(false);
    setVersion("");
    setFile(null);
    setLinkUrl("");
    setError(null);
  }

  // モード切替時：名前を自動セット（ユーザーが手で触っていなければ）
  function switchMode(next: "file" | "url") {
    setMode(next);
    setError(null);
    if (!nameTouched) {
      setName(next === "url" ? urlAutoName : (file ? stripExt(file.name) : ""));
    }
  }

  // ファイル選択時：拡張子を除いたファイル名をドキュメント名へ自動入力
  function onPickFile(f: File | null) {
    setFile(f);
    if (mode === "file" && !nameTouched && f) {
      setName(stripExt(f.name));
    }
  }

  async function load() {
    // この商談に紐づく契約書（category=contract / scope=deal）のみ取得
    const r = await fetch(`/api/documents?dealId=${dealId}&category=contract`);
    const j = await r.json();
    setDocs(j.documents ?? []);
  }
  useEffect(() => {
    load();
  }, [dealId]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "url") {
        const u = linkUrl.trim();
        if (!u || !(u.startsWith("https://") || u.startsWith("http://"))) {
          setError("URL（http:// または https://）を入力してください");
          setLoading(false);
          return;
        }
        const finalName = (name.trim() || urlAutoName);
        const r = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: finalName,
            category: "contract",
            scope: "deal",
            dealId,
            sourceType: "url",
            url: u,
            ...(version.trim() ? { version: version.trim() } : {}),
          }),
        });
        if (r.ok) {
          setOpen(false);
          resetForm();
          await load();
          router.refresh();
        } else {
          const j = await r.json().catch(() => null);
          setError(j?.error ?? `登録に失敗しました (HTTP ${r.status})`);
        }
        setLoading(false);
        return;
      }
      // mode === "file"
      if (!file || !name) {
        setLoading(false);
        return;
      }
      const fd = new FormData();
      fd.append("name", name);
      fd.append("category", "contract");
      fd.append("scope", "deal");
      fd.append("dealId", dealId);
      if (version.trim()) fd.append("version", version.trim());
      fd.append("file", file);
      const r = await fetch("/api/documents", { method: "POST", body: fd });
      if (r.ok) {
        setOpen(false);
        resetForm();
        await load();
        router.refresh();
      } else {
        const j = await r.json().catch(() => null);
        setError(j?.error ?? `アップロードに失敗しました (HTTP ${r.status})`);
      }
    } catch (err) {
      setError(`登録中にエラー: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  function remove(id: string) {
    if (!confirm("削除しますか？")) return;
    start(async () => {
      await fetch(`/api/documents/${id}`, { method: "DELETE" });
      await load();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-red-500 text-white p-1.5">
              <FileSignature className="h-4 w-4" />
            </div>
            この商談の個別契約書
            <Badge variant="secondary">{docs.length}</Badge>
          </span>
          <Button size="sm" variant="primary" onClick={() => { setOpen(!open); if (!open) { resetForm(); setName(""); } }}>
            <Upload className="h-3.5 w-3.5" />
            追加
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {open && (
          <form onSubmit={upload} className="space-y-3 mb-4 p-4 rounded-lg border border-red-200 bg-red-50/30">
            {/* ファイル / 外部URL 切替 */}
            <div className="inline-flex items-center gap-1 rounded-lg bg-white border border-zinc-200 p-1">
              <button
                type="button"
                onClick={() => switchMode("file")}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold ${mode === "file" ? "bg-red-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
              >
                <Upload className="h-3 w-3" /> ファイルをアップロード
              </button>
              <button
                type="button"
                onClick={() => switchMode("url")}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold ${mode === "url" ? "bg-red-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
              >
                <Link2 className="h-3 w-3" /> 外部リンクを登録
              </button>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">バージョン（任意）</Label>
              <Input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="例: v2 / 2026-05改訂"
              />
            </div>
            {mode === "file" ? (
              <>
                <div className="space-y-1">
                  <Label className="text-sm">契約書名</Label>
                  <Input
                    value={name}
                    onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
                    placeholder="例: ◯◯様 業務委託契約書"
                    required
                  />
                  <p className="text-[10px] text-zinc-400">ファイルを選ぶと、拡張子を除いたファイル名が自動入力されます（編集可）。</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-sm">ファイル</Label>
                  <input
                    type="file"
                    onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                    required
                    className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-red-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-red-700"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <Label className="text-sm">外部URL（Google Drive / クラウドサイン など）</Label>
                <Input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://..."
                  required
                />
                <p className="text-[10px] text-zinc-400">
                  契約書の名前は「<span className="font-medium">{urlAutoName}</span>」で自動登録されます。
                </p>
              </div>
            )}
            {error && (
              <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded leading-relaxed whitespace-pre-wrap">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); resetForm(); }}>
                キャンセル
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={loading || (mode === "file" ? (!name || !file) : !linkUrl.trim())}
              >
                {loading ? "保存中..." : "保存"}
              </Button>
            </div>
          </form>
        )}
        {docs.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-4">
            この商談用の個別契約書はまだありません。
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {docs.map((d) => {
              const isUrl = d.sourceType === "url";
              return (
                <li key={d.id} className="py-3 flex items-center gap-3">
                  <div className={`rounded-md p-2 ${isUrl ? "bg-sky-50" : "bg-red-50"}`}>
                    {isUrl ? <Link2 className="h-4 w-4 text-sky-600" /> : <FileText className="h-4 w-4 text-red-600" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {d.name}
                      {d.version && (
                        <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">{d.version}</span>
                      )}
                      {isUrl && (
                        <span className="ml-1.5 text-[10px] text-sky-600 font-normal">外部リンク</span>
                      )}
                    </p>
                    <p className="text-[11px] text-zinc-400 truncate">
                      {formatDate(d.createdAt)}
                      {isUrl ? ` ／ ${d.fileUrl}` : d.fileSize ? ` ／ ${(d.fileSize / 1024).toFixed(0)} KB` : ""}
                    </p>
                  </div>
                  {isUrl ? (
                    <a
                      href={d.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-sky-600 hover:underline inline-flex items-center gap-1 shrink-0"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      開く
                    </a>
                  ) : (
                    d.fileUrl && d.fileUrl !== "(リンク未登録)" && !d.fileUrl.includes(" ") && (
                      <a
                        href={`/api/documents/${d.id}/download`}
                        className="text-sm text-red-600 hover:underline inline-flex items-center gap-1 shrink-0"
                      >
                        <Download className="h-3.5 w-3.5" />
                        DL
                      </a>
                    )
                  )}
                  <button
                    onClick={() => remove(d.id)}
                    disabled={pending}
                    className="text-zinc-300 hover:text-red-500 shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
