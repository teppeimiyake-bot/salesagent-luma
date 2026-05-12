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
import { FileText, Upload, Download, Trash2, FolderOpen } from "lucide-react";
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
  createdAt: Date | string;
};

// この商談に紐づくドキュメントのカテゴリ（提案書 / 見積書 / その他）
const DEAL_DOC_CATEGORIES: { value: string; label: string; color: string }[] = [
  { value: "proposal", label: "提案書", color: "bg-emerald-100 text-emerald-700" },
  { value: "quote", label: "見積書", color: "bg-blue-100 text-blue-700" },
  { value: "other", label: "その他", color: "bg-zinc-100 text-zinc-600" },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  DEAL_DOC_CATEGORIES.map((c) => [c.value, c.label]),
);
const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(
  DEAL_DOC_CATEGORIES.map((c) => [c.value, c.color]),
);

export function DealDocuments({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("proposal");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

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
    if (!file || !name) return;
    setLoading(true);
    setError(null);
    try {
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
        setName("");
        setVersion("");
        setFile(null);
        setError(null);
        await load();
        router.refresh();
      } else {
        const j = await r.json().catch(() => null);
        setError(j?.error ?? `アップロードに失敗しました (HTTP ${r.status})`);
      }
    } catch (err) {
      setError(`アップロード中にエラー: ${(err as Error).message}`);
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
            この商談の提案書・見積書
            <Badge variant="secondary">{docs.length}</Badge>
          </span>
          <Button size="sm" variant="primary" onClick={() => setOpen(!open)}>
            <Upload className="h-3.5 w-3.5" />
            アップロード
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {open && (
          <form onSubmit={upload} className="space-y-3 mb-4 p-4 rounded-lg border border-emerald-200 bg-emerald-50/30">
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
            <div className="space-y-1">
              <Label className="text-sm">
                {category === "quote" ? "見積書名" : category === "proposal" ? "提案書名" : "ドキュメント名"}
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  category === "quote"
                    ? "例: ◯◯様 御見積書 v2"
                    : "例: ◯◯様向け提案書 v2"
                }
                required
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">ファイル</Label>
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
                className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-emerald-700"
              />
            </div>
            {error && (
              <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded leading-relaxed whitespace-pre-wrap">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }}>
                キャンセル
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={loading || !name || !file}>
                {loading ? "アップロード中..." : "保存"}
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
                  {grouped[cat].map((d) => (
                    <li key={d.id} className="py-3 flex items-center gap-3">
                      <div className="rounded-md bg-emerald-50 p-2">
                        <FileText className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {d.name}
                          {d.version && (
                            <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">{d.version}</span>
                          )}
                        </p>
                        <p className="text-[11px] text-zinc-400">
                          {formatDate(d.createdAt)}
                          {d.fileSize ? ` ／ ${(d.fileSize / 1024).toFixed(0)} KB` : ""}
                        </p>
                      </div>
                      {d.fileUrl && d.fileUrl !== "(リンク未登録)" && !d.fileUrl.includes(" ") && (
                        <a
                          href={`/api/documents/${d.id}/download`}
                          className="text-sm text-emerald-600 hover:underline inline-flex items-center gap-1"
                        >
                          <Download className="h-3.5 w-3.5" />
                          DL
                        </a>
                      )}
                      <button
                        onClick={() => remove(d.id)}
                        disabled={pending}
                        className="text-zinc-300 hover:text-red-500"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
