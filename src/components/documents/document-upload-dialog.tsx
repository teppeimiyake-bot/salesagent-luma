"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Upload } from "lucide-react";

const ALL_CATEGORIES: Record<string, string> = {
  proposal: "提案書",
  contract: "契約書",
  case_study: "導入事例",
  template: "テンプレート",
  other: "その他",
};

export function DocumentUploadDialog({
  defaultCategory = "proposal",
  allowedCategories,
  isContract = false,
}: {
  defaultCategory?: string;
  allowedCategories?: string[];
  isContract?: boolean;
} = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState(defaultCategory);
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCategory(defaultCategory);
  }, [defaultCategory]);

  const choices = allowedCategories ?? Object.keys(ALL_CATEGORIES);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    const fd = new FormData();
    fd.append("name", name);
    fd.append("category", category);
    fd.append("description", description);
    fd.append("file", file);
    const r = await fetch("/api/documents", { method: "POST", body: fd });
    setLoading(false);
    if (r.ok) {
      setOpen(false);
      setName("");
      setDescription("");
      setFile(null);
      router.refresh();
    } else {
      const j = await r.json().catch(() => ({}));
      setError(j.error ?? "アップロードに失敗しました");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Upload className="h-3.5 w-3.5" />
          アップロード
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            ドキュメントを追加
            {isContract && (
              <Badge variant="danger" className="ml-2">
                管理者専用
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {isContract
              ? "契約書はアクセス制御の対象です（管理者のみアップロード可）"
              : "提案書・導入事例・テンプレートなどを全社共通で管理"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">名前</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">カテゴリ</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((key) => (
                  <SelectItem key={key} value={key}>
                    {ALL_CATEGORIES[key] ?? key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">説明（任意）</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">ファイル</Label>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
              className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-emerald-700"
            />
          </div>
          {error && (
            <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !name || !file}>
              {loading ? "アップロード中..." : "アップロード"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
