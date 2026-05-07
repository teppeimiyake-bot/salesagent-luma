"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  createdAt: Date | string;
};

export function DealDocuments({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
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
    const fd = new FormData();
    fd.append("name", name);
    fd.append("category", "proposal");
    fd.append("scope", "deal");
    fd.append("dealId", dealId);
    fd.append("file", file);
    const r = await fetch("/api/documents", { method: "POST", body: fd });
    setLoading(false);
    if (r.ok) {
      setOpen(false);
      setName("");
      setFile(null);
      await load();
      router.refresh();
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
            <div className="rounded-lg bg-emerald-500 text-white p-1.5">
              <FolderOpen className="h-4 w-4" />
            </div>
            この商談の個別提案書
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
            <div className="space-y-1">
              <Label className="text-sm">提案書名</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: サクラ製作所様向け提案書 v2"
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
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
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
            この商談用の提案書はまだありません。
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {docs.map((d) => (
              <li key={d.id} className="py-3 flex items-center gap-3">
                <div className="rounded-md bg-emerald-50 p-2">
                  <FileText className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{d.name}</p>
                  <p className="text-[11px] text-zinc-400">
                    {formatDate(d.createdAt)}
                    {d.fileSize && ` ／ ${(d.fileSize / 1024).toFixed(0)} KB`}
                  </p>
                </div>
                {d.fileUrl.startsWith("/uploads/") && (
                  <a
                    href={d.fileUrl}
                    download
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
        )}
      </CardContent>
    </Card>
  );
}
