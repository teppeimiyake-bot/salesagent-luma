"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Copy,
  CheckCircle2,
  Trash2,
  Clock,
  Mail,
  RefreshCcw,
  Plus,
  AlertCircle,
} from "lucide-react";

type Invite = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permission: string;
  used: boolean;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
};

function isExpired(i: Invite): boolean {
  return new Date(i.expiresAt) < new Date();
}

function permissionBadgeVariant(p: string): "danger" | "info" | "secondary" {
  if (p === "admin") return "danger";
  if (p === "user") return "info";
  return "secondary";
}

function permissionLabel(p: string): string {
  if (p === "admin") return "管理者";
  if (p === "user") return "利用者";
  return "閲覧のみ";
}

export function InvitesAdmin() {
  const router = useRouter();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 新規発行ダイアログ
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"sales" | "manager">("sales");
  const [permission, setPermission] = useState<"admin" | "user" | "viewer">("user");
  const [expiresInHours, setExpiresInHours] = useState<string>("168");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<Invite | null>(null);

  async function fetchInvites() {
    setLoading(true);
    const r = await fetch("/api/invites");
    const j = await r.json();
    setInvites(j.invites ?? []);
    setLoading(false);
  }

  useEffect(() => {
    fetchInvites();
  }, []);

  function inviteUrl(token: Invite): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/register?invite=${(token as unknown as { token?: string }).token ?? ""}`;
  }

  // 発行直後の URL は createdInvite に保持（GET /api/invites では token も返している）
  // 既存招待の URL も token があるので構築できる

  async function copyUrl(invite: Invite) {
    const t = (invite as unknown as { token?: string }).token;
    if (!t) return;
    const url = `${window.location.origin}/register?invite=${t}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // noop
    }
  }

  function remove(i: Invite) {
    if (!confirm(`招待「${i.email}」を取消しますか？\n（このURLは無効になります）`)) return;
    start(async () => {
      const r = await fetch(`/api/invites?id=${i.id}`, { method: "DELETE" });
      if (r.ok) {
        setInvites((arr) => arr.filter((x) => x.id !== i.id));
        router.refresh();
      }
    });
  }

  async function reissue(i: Invite) {
    // 同じ email/role/permission で再発行（古いものは API側で used=true に倒される）
    setCreating(true);
    setCreateError(null);
    const r = await fetch("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: i.email,
        name: i.name ?? undefined,
        role: i.role,
        permission: i.permission,
        expiresInHours: 168,
      }),
    });
    const j = await r.json();
    setCreating(false);
    if (!r.ok) {
      alert(j.error ?? "再発行に失敗しました");
      return;
    }
    await fetchInvites();
    setCreatedInvite(j.invite);
    setOpen(true);
  }

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const r = await fetch("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: name || undefined,
        role,
        permission,
        expiresInHours: Number(expiresInHours),
      }),
    });
    const j = await r.json();
    setCreating(false);
    if (!r.ok) {
      setCreateError(j.error ?? "招待URLの生成に失敗しました");
      return;
    }
    setCreatedInvite(j.invite);
    await fetchInvites();
    router.refresh();
  }

  function resetNewForm() {
    setName("");
    setEmail("");
    setRole("sales");
    setPermission("user");
    setExpiresInHours("168");
    setCreateError(null);
    setCreatedInvite(null);
  }

  const pendingInvites = invites.filter((i) => !i.used && !isExpired(i));
  const usedOrExpired = invites.filter((i) => i.used || isExpired(i));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-zinc-700">
            <strong>{pendingInvites.length}</strong> 件の有効な招待 ／{" "}
            <span className="text-zinc-500">
              {usedOrExpired.length} 件の使用済・期限切れ
            </span>
          </p>
        </div>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) resetNewForm();
          }}
        >
          <DialogTrigger asChild>
            <Button variant="primary" size="sm">
              <Plus className="h-3.5 w-3.5" />
              招待URLを発行
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="inline-flex items-center gap-2">
                <Mail className="h-4 w-4" />
                招待URLを発行
                <Badge variant="danger" className="ml-1">管理者専用</Badge>
              </DialogTitle>
              <DialogDescription>
                発行されたURLを本人に送ると、メール固定 + パスワード設定で登録完了します
              </DialogDescription>
            </DialogHeader>
            {createdInvite ? (
              <div className="space-y-3">
                <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-4 space-y-2">
                  <p className="text-sm font-bold text-emerald-900 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    招待URLを生成しました
                  </p>
                  <p className="text-xs text-emerald-800">
                    宛先: <span className="font-mono">{createdInvite.email}</span>
                  </p>
                  <p className="text-xs text-emerald-700">
                    有効期限: {new Date(createdInvite.expiresAt).toLocaleString("ja-JP")}
                  </p>
                  <div className="rounded bg-white border border-emerald-200 p-3">
                    <p className="text-[10px] text-emerald-700 mb-1.5 font-bold">招待URL（クリックでコピー）</p>
                    <button
                      type="button"
                      onClick={() => {
                        const t = (createdInvite as unknown as { token: string }).token;
                        const url = `${window.location.origin}/register?invite=${t}`;
                        navigator.clipboard.writeText(url);
                        setCopiedId(createdInvite.id);
                        setTimeout(() => setCopiedId(null), 2000);
                      }}
                      className="w-full text-left flex items-center gap-2 group"
                    >
                      <code className="text-xs font-mono break-all flex-1 text-emerald-900 group-hover:underline">
                        {window.location.origin}/register?invite=
                        {(createdInvite as unknown as { token: string }).token}
                      </code>
                      <Copy className="h-4 w-4 text-emerald-600 shrink-0" />
                    </button>
                    {copiedId === createdInvite.id && (
                      <p className="text-[10px] text-emerald-700 mt-1.5 font-bold">✓ コピーしました</p>
                    )}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={resetNewForm}>
                    <Plus className="h-3.5 w-3.5" />
                    続けて発行
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => { setOpen(false); resetNewForm(); }}>
                    閉じる
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitNew} className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">氏名（任意・本人が後から編集可）</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">メールアドレス（ログインID／固定）</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">役職</Label>
                    <Select value={role} onValueChange={(v) => setRole(v as "sales" | "manager")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sales">メンバー</SelectItem>
                        <SelectItem value="manager">マネージャー</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">権限</Label>
                    <Select
                      value={permission}
                      onValueChange={(v) => setPermission(v as "admin" | "user" | "viewer")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">管理者</SelectItem>
                        <SelectItem value="user">利用者</SelectItem>
                        <SelectItem value="viewer">閲覧のみ</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">有効期限</Label>
                    <Select value={expiresInHours} onValueChange={setExpiresInHours}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="24">24時間</SelectItem>
                        <SelectItem value="72">3日</SelectItem>
                        <SelectItem value="168">7日</SelectItem>
                        <SelectItem value="336">14日</SelectItem>
                        <SelectItem value="720">30日</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {createError && (
                  <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded inline-flex items-center gap-1.5">
                    <AlertCircle className="h-3 w-3" />
                    {createError}
                  </p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    キャンセル
                  </Button>
                  <Button type="submit" variant="primary" disabled={creating || !email}>
                    {creating ? "発行中..." : "招待URLを生成"}
                  </Button>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500 py-4 text-center">読み込み中...</p>
      ) : (
        <>
          {/* 有効な招待 */}
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-zinc-700 inline-flex items-center gap-2 border-b border-zinc-200 pb-1.5">
              <Mail className="h-4 w-4 text-emerald-500" />
              有効な招待
              <Badge variant="info" className="text-[10px]">{pendingInvites.length}</Badge>
            </h3>
            {pendingInvites.length === 0 ? (
              <p className="text-xs text-zinc-400 px-2 py-3">有効な招待はありません</p>
            ) : (
              <div className="space-y-2">
                {pendingInvites.map((i) => (
                  <Card key={i.id} className="p-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm">{i.email}</span>
                          {i.name && <span className="text-xs text-zinc-500">／ {i.name}</span>}
                          <Badge variant={permissionBadgeVariant(i.permission)} className="text-[10px]">
                            {permissionLabel(i.permission)}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {i.role === "manager" ? "マネージャー" : "メンバー"}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-zinc-500 mt-1 inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          発行: {new Date(i.createdAt).toLocaleString("ja-JP")} ／ 期限:{" "}
                          {new Date(i.expiresAt).toLocaleString("ja-JP")}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyUrl(i)}
                          title="招待URLをコピー"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {copiedId === i.id ? "コピー済" : "URLコピー"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => reissue(i)}
                          disabled={creating}
                          title="同じ条件で再発行（期限を更新）"
                        >
                          <RefreshCcw className="h-3.5 w-3.5" />
                          再発行
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-rose-200 text-rose-600 hover:bg-rose-50"
                          onClick={() => remove(i)}
                          disabled={pending}
                          title="招待を取消"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* 履歴（使用済 + 期限切れ） */}
          {usedOrExpired.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-500 border-b border-zinc-200 pb-1.5">
                使用済 ／ 期限切れ
                <Badge variant="secondary" className="ml-2 text-[10px]">{usedOrExpired.length}</Badge>
              </h3>
              <div className="space-y-1">
                {usedOrExpired.slice(0, 30).map((i) => {
                  const expired = isExpired(i) && !i.used;
                  return (
                    <div
                      key={i.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-zinc-200 bg-zinc-50/50 text-xs"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-zinc-700">{i.email}</span>
                        <Badge
                          variant={i.used ? "success" : "secondary"}
                          className="ml-2 text-[10px]"
                        >
                          {i.used ? "使用済" : expired ? "期限切れ" : "—"}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(i)}
                        className="text-zinc-400 hover:text-rose-600"
                        disabled={pending}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
