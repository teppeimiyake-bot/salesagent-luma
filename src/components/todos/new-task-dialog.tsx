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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";

type Deal = { id: string; productName: string; company: { name: string } };

export function NewTaskDialog({ defaultDealId }: { defaultDealId?: string } = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealId, setDealId] = useState(defaultDealId ?? "");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || defaultDealId) return;
    fetch("/api/deals")
      .then((r) => r.json())
      .then((j) => setDeals(j.deals ?? []));
  }, [open, defaultDealId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dealId,
        title,
        reason: reason || undefined,
        priority,
        dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
        isAiGenerated: false,
      }),
    });
    setLoading(false);
    if (res.ok) {
      setOpen(false);
      setTitle("");
      setReason("");
      setDueDate("");
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus className="h-4 w-4" />
          ToDo追加
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ToDoを追加</DialogTitle>
          <DialogDescription>商談に紐づく具体的なアクションを登録</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {!defaultDealId && (
            <div className="space-y-1">
              <Label className="text-sm">対象商談</Label>
              <Select value={dealId} onValueChange={setDealId}>
                <SelectTrigger>
                  <SelectValue placeholder="商談を選択" />
                </SelectTrigger>
                <SelectContent>
                  {deals.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.company.name} / {d.productName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-sm">タイトル</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="例: 決裁者面談の日程調整メールを送付"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">理由（任意）</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="なぜこのアクションが必要か"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">優先度</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">最優先</SelectItem>
                  <SelectItem value="medium">優先</SelectItem>
                  <SelectItem value="low">通常</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">期日</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !title || !dealId}>
              {loading ? "追加中..." : "追加"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
