"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FileText, Upload, Download, Trash2, Receipt } from "lucide-react";
import { formatDate } from "@/lib/utils";

type Quote = {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: Date | string;
};

export function DealQuotes({
  dealId,
  canEdit,
}: {
  dealId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/documents?dealId=${dealId}&category=quote`);
    const j = await r.json();
    setQuotes(j.documents ?? []);
  }
  useEffect(() => {
    load();
  }, [dealId]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!files || files.length === 0) return;
    setLoading(true);
    setMsg(`${files.length}件アップロード中...`);
    const next = quotes.length;
    let okCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fd = new FormData();
      // 複数枚一括アップロード時は「ファイル名」をベースに、versionは入力値か "v{N}"
      const idx = next + i + 1;
      fd.append("name", files.length === 1 && name ? name : (name || file.name));
      fd.append("category", "quote");
      fd.append("scope", "deal");
      fd.append("dealId", dealId);
      if (version) fd.append("version", `${version}${files.length > 1 ? `-${i + 1}` : ""}`);
      else fd.append("version", `v${idx}`);
      fd.append("file", file);
      const r = await fetch("/api/documents", { method: "POST", body: fd });
      if (r.ok) okCount++;
    }
    setLoading(false);
    setMsg(`✓ ${okCount}/${files.length}件 アップロード完了`);
    setOpen(false);
    setName("");
    setVersion("");
    setFiles(null);
    await load();
    router.refresh();
    setTimeout(() => setMsg(null), 3000);
  }

  function remove(id: string) {
    if (!confirm("この見積書を削除しますか？")) return;
    start(async () => {
      await fetch(`/api/documents/${id}`, { method: "DELETE" });
      await load();
      router.refresh();
    });
  }

  return (
    <Card className="border-sky-200 bg-gradient-to-br from-sky-50/40 via-white to-cyan-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-sky-500 to-cyan-500 text-white p-1.5 shadow-sm">
              <Receipt className="h-4 w-4" />
            </div>
            見積書（複数バージョン管理）
            <Badge variant="secondary">{quotes.length}件</Badge>
          </span>
          {canEdit && (
            <Button size="sm" variant="primary" onClick={() => setOpen(!open)}>
              <Upload className="h-3.5 w-3.5" />
              アップロード
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {open && canEdit && (
          <form
            onSubmit={upload}
            className="space-y-3 mb-4 p-4 rounded-lg border border-sky-200 bg-sky-50/30"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2 space-y-1">
                <Label className="text-sm">ベース名（複数枚時はファイル名で自動命名）</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例: サクラ製作所様 見積"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm">バージョン（任意）</Label>
                <Input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="例: v2 / 値引き案"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">ファイル（複数選択可）</Label>
              <input
                type="file"
                multiple
                onChange={(e) => setFiles(e.target.files)}
                required
                className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-sky-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-sky-700"
              />
              {files && files.length > 0 && (
                <p className="text-xs text-sky-700">
                  {files.length} 件選択中
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                キャンセル
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={loading || !files || files.length === 0}
              >
                {loading ? "アップロード中..." : "保存"}
              </Button>
            </div>
            <p className="text-xs text-zinc-500">
              💡 1商談で複数の見積書バージョンを管理できます。値引き案・プラン違いなどを並列で保管。
            </p>
          </form>
        )}

        {msg && (
          <p className="text-xs text-sky-700 bg-sky-50 px-3 py-2 rounded mb-2">{msg}</p>
        )}

        {quotes.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-4">
            見積書はまだ登録されていません。{canEdit ? "右上の「アップロード」から追加してください。" : ""}
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {quotes.map((d) => (
              <li key={d.id} className="py-3 flex items-center gap-3">
                <div className="rounded-md bg-sky-50 p-2 shrink-0">
                  <FileText className="h-4 w-4 text-sky-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm font-medium truncate">{d.name}</p>
                    {d.version && (
                      <Badge variant="info" className="text-[10px]">
                        {d.version}
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    {formatDate(d.createdAt)}
                    {d.fileSize ? ` ／ ${(d.fileSize / 1024).toFixed(0)} KB` : ""}
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
                {canEdit && (
                  <button
                    onClick={() => remove(d.id)}
                    disabled={pending}
                    className="text-zinc-300 hover:text-red-500"
                    title="削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
