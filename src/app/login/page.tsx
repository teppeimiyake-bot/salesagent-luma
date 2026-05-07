"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied:
    "このメールアドレスはログインを許可されていません。管理者から招待を受けてください。",
  Configuration: "認証プロバイダの設定が不足しています（管理者にご連絡ください）。",
  Verification: "認証リンクが無効、または期限切れです。",
  OAuthSignin: "Googleログインの開始に失敗しました。",
  OAuthCallback: "Googleコールバックの処理に失敗しました。",
  OAuthAccountNotLinked:
    "このGoogleアカウントは別のログイン方式と紐付けられています。",
};

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams();
  const from = search.get("from") || "/";
  const errorCode = search.get("error");
  const [email, setEmail] = useState("demo@salesagent.local");
  const [password, setPassword] = useState("demo1234");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    errorCode ? ERROR_MESSAGES[errorCode] ?? `認証エラー: ${errorCode}` : null,
  );
  const [googleAvailable, setGoogleAvailable] = useState(false);

  useEffect(() => {
    fetch("/api/auth/providers-info")
      .then((r) => r.json())
      .then((j) => setGoogleAvailable(!!j.google))
      .catch(() => setGoogleAvailable(false));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "ログインに失敗しました");
      setLoading(false);
      return;
    }
    router.push(from);
    router.refresh();
  }

  function onGoogle() {
    // NextAuth: 直接 OAuth フローを開始。callbackUrl 付き。
    const callback = encodeURIComponent(from);
    window.location.href = `/api/auth/signin/google?callbackUrl=${callback}`;
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-center gap-2 mb-2">
          <div className="rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight">
            株式会社Luma <span className="text-orange-600">Sales Agent</span>
          </span>
        </div>
        <CardTitle>ログイン</CardTitle>
        <CardDescription>営業が考えなくても、勝ち筋と次の一手が出る</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Googleログイン（招待制） */}
        {googleAvailable && (
          <div className="mb-4 space-y-2">
            <button
              type="button"
              onClick={onGoogle}
              className="w-full inline-flex items-center justify-center gap-3 px-4 py-2.5 rounded-md border border-zinc-300 bg-white hover:bg-zinc-50 text-sm font-semibold text-zinc-700 shadow-sm transition-colors"
            >
              <GoogleIcon />
              Googleでログイン
            </button>
            <p className="text-[11px] text-zinc-500 text-center">
              招待されたメールアドレスのみログインできます
            </p>
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-zinc-200" />
              </div>
              <div className="relative flex justify-center text-[11px]">
                <span className="px-2 bg-white text-zinc-400">または</span>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">メールアドレス</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">パスワード</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" className="w-full" disabled={loading}>
            {loading ? "ログイン中..." : "ログイン"}
          </Button>
          <p className="text-xs text-zinc-500 text-center">
            アカウントが無い場合は{" "}
            <Link href="/register" className="text-orange-600 hover:underline">
              新規登録
            </Link>
          </p>
          <p className="text-xs text-zinc-400 text-center">
            デモ：demo@salesagent.local / demo1234（seed後）
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={null}>
        <LoginInner />
      </Suspense>
    </div>
  );
}
