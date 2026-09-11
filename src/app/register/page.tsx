"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkles, MailCheck, AlertCircle } from "lucide-react";

type Invite = {
  email: string;
  name: string | null;
  role: string;
  permission: string;
  expiresAt: string;
  tenantCode: string | null;
  tenantName: string | null;
  tenantShortName: string | null;
};

function RegisterInner() {
  const router = useRouter();
  const search = useSearchParams();
  const inviteToken = search.get("invite");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 招待トークン情報
  const [invite, setInvite] = useState<Invite | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    setInviteLoading(true);
    // サーバーが 500 を返すと本文が JSON ではないため、r.json() がそのまま throw する。
    // 以前はこれを拾っておらず「読み込み中のまま何も出ない」白画面になっていた。
    // 必ず catch して理由を画面に出す。
    (async () => {
      try {
        const r = await fetch(`/api/invites/${encodeURIComponent(inviteToken)}`);
        const j = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !j?.invite) {
          setInviteError(
            j?.error ?? `招待URLを確認できませんでした（サーバーエラー: ${r.status}）`,
          );
          return;
        }
        setInvite(j.invite);
        setEmail(j.invite.email);
        if (j.invite.name) setName(j.invite.name);
      } catch {
        if (!cancelled) setInviteError("招待URLの確認中に通信エラーが発生しました");
      } finally {
        if (!cancelled) setInviteLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: invite ? undefined : email,
        password,
        name: name || undefined,
        inviteToken: inviteToken ?? undefined,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "登録に失敗しました");
      setLoading(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-orange-600" />
            新規登録
          </CardTitle>
          <CardDescription>
            {inviteToken
              ? "管理者から発行された招待URLでアカウントを作成します"
              : "株式会社Luma Sales Agent を使い始める"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inviteToken && inviteLoading && (
            <p className="text-sm text-zinc-500 text-center py-3">招待URLを確認中...</p>
          )}
          {inviteError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 mb-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
              <div className="text-sm text-red-700">
                <p className="font-semibold">この招待URLは使えません</p>
                <p className="text-xs mt-1">{inviteError}</p>
                <p className="text-xs mt-2 text-zinc-500">
                  管理者に新しい招待URLを発行してもらってください。
                </p>
              </div>
            </div>
          )}
          {invite && !inviteError && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 mb-3">
              <p className="text-xs font-semibold text-emerald-900 inline-flex items-center gap-1">
                <MailCheck className="h-3.5 w-3.5" />
                招待を確認しました
              </p>
              <div className="mt-2 space-y-1 text-xs text-emerald-800">
                {invite.tenantName && (
                  <p>
                    所属会社: <span className="font-semibold">{invite.tenantName}</span>
                  </p>
                )}
                <p>
                  メール: <span className="font-mono">{invite.email}</span>
                </p>
                <p className="inline-flex items-center gap-1.5">
                  権限:{" "}
                  <Badge
                    variant={
                      invite.permission === "admin"
                        ? "danger"
                        : invite.permission === "user"
                          ? "info"
                          : "secondary"
                    }
                  >
                    {invite.permission === "admin"
                      ? "管理者"
                      : invite.permission === "user"
                        ? "利用者"
                        : "閲覧のみ"}
                  </Badge>
                  <span>役職:</span>
                  <Badge variant="outline">
                    {invite.role === "manager" ? "マネージャー" : "メンバー"}
                  </Badge>
                </p>
              </div>
            </div>
          )}
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">お名前</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス{invite && "（招待で固定）"}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={!!invite}
                className={invite ? "bg-zinc-100" : ""}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">パスワード（8文字以上）</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={loading || (!!inviteToken && (inviteLoading || !!inviteError))}
            >
              {loading ? "登録中..." : invite ? "招待を受け入れて登録" : "登録"}
            </Button>
            <p className="text-xs text-zinc-500 text-center">
              すでにアカウントを持っている場合は{" "}
              <Link href="/login" className="text-emerald-600 hover:underline">
                ログイン
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-sm text-zinc-500">読み込み中...</div>}>
      <RegisterInner />
    </Suspense>
  );
}
