"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, Upload, Download, Trash2, FolderOpen, ExternalLink, Link2 } from "lucide-react";
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

// この商談に紐づくドキュメントのカテゴリ（提案書 / その他）
// 見積書は廃止（社長指示 2026-08-02）。見積は「見積書 自動作成」に一本化する。
// 過去に category='quote' で登録された書類は「その他」に寄せて表示だけ残す。
const DEAL_DOC_CATEGORIES: { value: string; label: string; color: string }[] = [
  { value: "proposal", label: "提案書", color: "bg-emerald-100 text-emerald-700" },
  { value: "other", label: "その他", color: "bg-zinc-100 text-zinc-600" },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  DEAL_DOC_CATEGORIES.map((c) => [c.value, c.label]),
);
const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(
  DEAL_DOC_CATEGORIES.map((c) => [c.value, c.color]),
);

/** ファイル名から拡張子を除いた文字列を返す */
function stripExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

export function DealDocuments({ dealId, companyName }: { dealId: string; companyName?: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState(false);
  // 登録モード：file = アップロード / url = 外部リンク
  const [mode, setMode] = useState<"file" | "url">("file");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [category, setCategory] = useState("proposal");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const urlAutoName = companyName ? `${companyName} 提案企画書` : "提案企画書";

  function resetForm() {
    setMode("file");
    setName("");
    setNameTouched(false);
    setCategory("proposal");
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

  function onPickFile(f: File | null) {
    setFile(f);
    if (mode === "file" && !nameTouched && f) {
      setName(stripExt(f.name));
    }
  }

  async function load() {
    const r = await fetch(`/api/documents?dealId=${dealId}`);
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
            category,
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
      fd.append("category", category);
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

  const grouped = docs.reduce<Record<string, Doc[]>>((acc, d) => {
    const key = CATEGORY_LABEL[d.category] ? d.category : "other";
    (acc[key] ??= []).push(d);
    return acc;
  }, {});
  // 表示順：提案書 → 見積書 → その他
  const orderedCats = DEAL_DOC_CATEGORIES.map((c) => c.value).filter((c) => grouped[c]?.length);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-emerald-500 text-white p-1.5">
              <FolderOpen className="h-4 w-4" />
            </div>
            この商談の提案書
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
          <form onSubmit={upload} className="space-y-3 mb-4 p-4 rounded-lg border border-emerald-200 bg-emerald-50/30">
            {/* ファイル / 外部URL 切替 */}
            <div className="inline-flex items-center gap-1 rounded-lg bg-white border border-zinc-200 p-1">
              <button
                type="button"
                onClick={() => switchMode("file")}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold ${mode === "file" ? "bg-emerald-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
              >
                <Upload className="h-3 w-3" /> ファイルをアップロード
              </button>
              <button
                type="button"
                onClick={() => switchMode("url")}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold ${mode === "url" ? "bg-emerald-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
              >
                <Link2 className="h-3 w-3" /> 外部リンクを登録
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-sm">種別</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEAL_DOC_CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm">バージョン（任意）</Label>
                <Input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="例: v2 / 2026-05改訂"
                />
              </div>
            </div>
            {mode === "file" ? (
              <>
                <div className="space-y-1">
                  <Label className="text-sm">
                    {category === "proposal" ? "提案書名" : "ドキュメント名"}
                  </Label>
                  <Input
                    value={name}
                    onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
                    placeholder="例: ◯◯様向け提案書 v2"
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
                    className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-emerald-700"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <Label className="text-sm">外部URL（Canva / Google Slides / Drive など）</Label>
                <Input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://www.canva.com/design/..."
                  required
                />
                <p className="text-[10px] text-zinc-400">
                  企画書の名前は「<span className="font-medium">{urlAutoName}</span>」で自動登録されます。
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
            この商談用の提案書・見積書はまだありません。
          </p>
        ) : (
          <div className="space-y-4">
            {orderedCats.map((cat) => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-1.5 px-0.5">
                  <span className={`text-[11px] font-semibold rounded px-1.5 py-0.5 ${CATEGORY_COLOR[cat]}`}>
                    {CATEGORY_LABEL[cat]}
                  </span>
                  <Badge variant="outline" className="text-[10px]">{grouped[cat].length}</Badge>
                </div>
                <ul className="divide-y divide-zinc-100">
                  {grouped[cat].map((d) => {
                    const isUrl = d.sourceType === "url";
                    return (
                    <li key={d.id} className="py-3 flex items-center gap-3">
                      <div className={`rounded-md p-2 ${isUrl ? "bg-sky-50" : "bg-emerald-50"}`}>
                        {isUrl ? <Link2 className="h-4 w-4 text-sky-600" /> : <FileText className="h-4 w-4 text-emerald-600" />}
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
                            className="text-sm text-emerald-600 hover:underline inline-flex items-center gap-1 shrink-0"
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
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
