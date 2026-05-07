"use client";
import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  UserPlus,
  CheckCircle2,
  Link as LinkIcon,
  Copy,
  KeyRound,
} from "lucide-react";

type Mode = "invite" | "direct";

export function NewMemberDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("invite");

  // 共通フィールド
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"sales" | "manager">("sales");
  const [permission, setPermission] = useState<"admin" | "user" | "viewer">("user");

  // direct 用
  const [password, setPassword] = useState("");

  // invite 用
  const [expiresInHours, setExpiresInHours] = useState<string>("168");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directSuccess, setDirectSuccess] = useState<{ name: string; initialPassword?: string } | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<{
    email: string;
    inviteUrl: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setEmail("");
    setRole("sales");
    setPermission("user");
    setPassword("");
    setExpiresInHours("168");
    setError(null);
    setDirectSuccess(null);
    setInviteSuccess(null);
    setCopied(false);
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
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
    setLoading(false);
    if (!r.ok) {
      setError(j.error ?? "招待URLの生成に失敗しました");
      return;
    }
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    setInviteSuccess({
      email: j.invite.email,
      inviteUrl: `${origin}/register?invite=${j.invite.token}`,
      expiresAt: j.invite.expiresAt,
    });
    router.refresh();
  }

  async function submitDirect(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const r = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        role,
        permission,
        password: password || undefined,
      }),
    });
    const j = await r.json();
    setLoading(false);
    if (!r.ok) {
      setError(j.error ?? "登録に失敗しました");
      return;
    }
    setDirectSuccess({ name: j.user.name, initialPassword: j.initialPassword });
    router.refresh();
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // noop
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <UserPlus className="h-3.5 w-3.5" />
          メンバー追加
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            メンバーを追加
            <Badge variant="danger" className="ml-2">
              管理者専用
            </Badge>
          </DialogTitle>
          <DialogDescription>
            招待URL（推奨：本人がパスワード設定）／直接登録（管理者がパスワード設定）
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => { setMode(v as Mode); reset(); }}>
          <TabsList className="grid grid-cols-2 max-w-md">
            <TabsTrigger value="invite">
              <LinkIcon className="h-3.5 w-3.5 mr-1" />
              招待URL生成
            </TabsTrigger>
            <TabsTrigger value="direct">
              <KeyRound className="h-3.5 w-3.5 mr-1" />
              直接登録
            </TabsTrigger>
          </TabsList>

          <TabsContent value="invite" className="mt-4">
            {inviteSuccess ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 space-y-2">
                  <p className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    招待URLを生成しました
                  </p>
                  <p className="text-xs text-emerald-800">
                    宛先: <span className="font-mono">{inviteSuccess.email}</span>
                  </p>
                  <p className="text-xs text-emerald-700">
                    有効期限: {new Date(inviteSuccess.expiresAt).toLocaleString("ja-JP")}
                  </p>
                  <div className="rounded bg-white border border-emerald-200 p-2 flex items-center gap-2">
                    <code className="text-xs font-mono break-all flex-1">
                      {inviteSuccess.inviteUrl}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyUrl(inviteSuccess.inviteUrl)}
                      className="shrink-0"
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? "コピー済" : "コピー"}
                    </Button>
                  </div>
                  <p className="text-xs text-emerald-700">
                    このURLを本人にメール／Slackで送ってください。アクセスするとメール固定でパスワードのみ入力で登録完了します。
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => reset()}>
                    <Plus className="h-3.5 w-3.5" />
                    続けて発行
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setOpen(false)}>
                    閉じる
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitInvite} className="space-y-3">
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
                {error && (
                  <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    キャンセル
                  </Button>
                  <Button type="submit" variant="primary" disabled={loading || !email}>
                    {loading ? "発行中..." : "招待URLを生成"}
                  </Button>
                </div>
              </form>
            )}
          </TabsContent>

          <TabsContent value="direct" className="mt-4">
            {directSuccess ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    {directSuccess.name} さんを登録しました
                  </p>
                  {directSuccess.initialPassword && (
                    <p className="text-sm text-emerald-800 mt-2">
                      初期パスワード:{" "}
                      <code className="px-2 py-0.5 bg-white border border-emerald-200 rounded font-mono">
                        {directSuccess.initialPassword}
                      </code>
                      <br />
                      <span className="text-xs text-emerald-700">
                        本人にお伝えし、初回ログイン後に変更してもらってください。
                      </span>
                    </p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => reset()}>
                    <Plus className="h-3.5 w-3.5" />
                    続けて追加
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setOpen(false)}>
                    閉じる
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitDirect} className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">氏名</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">メールアドレス（ログインID）</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
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
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">初期パスワード（空欄なら demo1234）</Label>
                  <Input
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="8文字以上 / 空欄で demo1234"
                    minLength={8}
                  />
                </div>
                {error && (
                  <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    キャンセル
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={loading || !name || !email}
                  >
                    {loading ? "登録中..." : "登録"}
                  </Button>
                </div>
              </form>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
