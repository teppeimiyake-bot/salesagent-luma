"use client";
import { useState, useTransition, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ChevronDown, KeyRound, LogOut, CheckCircle2, AlertCircle, ImageIcon, Trash2, UserCog } from "lucide-react";

type Permission = "admin" | "user" | "viewer";

export function UserMenu({
  user,
}: {
  user: { name: string; email: string; avatarColor: string | null; avatarUrl?: string | null; permission: Permission };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // メニュー外クリックで閉じる
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const permLabel =
    user.permission === "admin" ? "管理者" : user.permission === "user" ? "利用者" : "閲覧のみ";
  const permVariant =
    user.permission === "admin" ? "danger" : user.permission === "user" ? "info" : "secondary";

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 rounded-md hover:bg-zinc-100 px-2 py-1 transition-colors"
        >
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.avatarUrl}
              alt={user.name}
              className="w-8 h-8 rounded-full object-cover border border-zinc-200"
            />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
              style={{ background: user.avatarColor ?? "#6366f1" }}
            >
              {user.name.charAt(0)}
            </div>
          )}
          <div className="text-left">
            <p className="text-xs font-semibold leading-tight">{user.name}</p>
            <Badge variant={permVariant} className="text-[9px] px-1.5 py-0">
              {permLabel}
            </Badge>
          </div>
          <ChevronDown
            className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 w-64 z-50 rounded-xl border border-zinc-200 bg-white shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-100 bg-gradient-to-br from-orange-50/40 via-white to-amber-50/30">
              <p className="text-sm font-semibold leading-tight">{user.name}</p>
              <p className="text-[11px] text-zinc-500 truncate">{user.email}</p>
            </div>
            <ul className="py-1">
              <li>
                <button
                  onClick={() => {
                    setNameOpen(true);
                    setOpen(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-orange-50 flex items-center gap-2 text-zinc-700"
                >
                  <UserCog className="h-4 w-4 text-orange-500" />
                  名前変更
                </button>
              </li>
              <li>
                <button
                  onClick={() => {
                    setAvatarOpen(true);
                    setOpen(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-orange-50 flex items-center gap-2 text-zinc-700"
                >
                  <ImageIcon className="h-4 w-4 text-orange-500" />
                  アイコン変更
                </button>
              </li>
              <li>
                <button
                  onClick={() => {
                    setPwOpen(true);
                    setOpen(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-orange-50 flex items-center gap-2 text-zinc-700"
                >
                  <KeyRound className="h-4 w-4 text-orange-500" />
                  パスワード変更
                </button>
              </li>
              <li>
                <button
                  onClick={logout}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-rose-50 flex items-center gap-2 text-zinc-700"
                >
                  <LogOut className="h-4 w-4 text-rose-500" />
                  ログアウト
                </button>
              </li>
            </ul>
          </div>
        )}
      </div>

      <PasswordChangeDialog open={pwOpen} onOpenChange={setPwOpen} />
      <AvatarChangeDialog
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        currentUrl={user.avatarUrl ?? null}
        userName={user.name}
        avatarColor={user.avatarColor}
      />
      <NameChangeDialog
        open={nameOpen}
        onOpenChange={setNameOpen}
        currentName={user.name}
      />
    </>
  );
}

function NameChangeDialog({
  open,
  onOpenChange,
  currentName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, start] = useTransition();

  // ダイアログを開いた時に最新の表示名で初期化
  useEffect(() => {
    if (open) {
      setName(currentName);
      setError(null);
      setSuccess(false);
    }
  }, [open, currentName]);

  function reset() {
    setName(currentName);
    setError(null);
    setSuccess(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("氏名を入力してください");
      return;
    }
    if (trimmed.length > 100) {
      setError("氏名は100文字以内で入力してください");
      return;
    }
    if (trimmed === currentName) {
      setError("現在と異なる名前を入力してください");
      return;
    }
    start(async () => {
      const r = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "名前の変更に失敗しました");
        return;
      }
      setSuccess(true);
      // メニュー上の表示名も更新するためサーバーコンポーネントを再描画
      router.refresh();
      // 1.5秒後にダイアログを閉じる
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(false);
      }, 1500);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5">
              <UserCog className="h-4 w-4" />
            </div>
            名前変更
          </DialogTitle>
          <DialogDescription>
            画面上に表示されるご自身の氏名を変更します。メールアドレスや権限は変更できません。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="user-name" className="text-sm">氏名</Label>
            <Input
              id="user-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              disabled={pending || success}
              autoFocus
            />
            <p className="text-[11px] text-zinc-500">最大100文字。空白のみは不可。</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-start gap-2 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>名前を変更しました。</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending || success}>
              {pending ? "変更中..." : "変更する"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AvatarChangeDialog({
  open,
  onOpenChange,
  currentUrl,
  userName,
  avatarColor,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentUrl: string | null;
  userName: string;
  avatarColor: string | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      setError("ファイルサイズは 5MB までです");
      return;
    }
    setError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  function upload() {
    if (!file) return;
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/auth/avatar", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "アップロードに失敗しました");
        return;
      }
      onOpenChange(false);
      reset();
      router.refresh();
    });
  }

  function removeAvatar() {
    setError(null);
    start(async () => {
      const r = await fetch("/api/auth/avatar", { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? "削除に失敗しました");
        return;
      }
      onOpenChange(false);
      reset();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5">
              <ImageIcon className="h-4 w-4" />
            </div>
            アイコン変更
          </DialogTitle>
          <DialogDescription>
            プロフィール画像をアップロードします。PNG / JPEG / WebP / GIF、5MB まで。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="プレビュー"
                className="w-20 h-20 rounded-full object-cover border border-zinc-200"
              />
            ) : currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentUrl}
                alt={userName}
                className="w-20 h-20 rounded-full object-cover border border-zinc-200"
              />
            ) : (
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-white text-2xl font-bold"
                style={{ background: avatarColor ?? "#6366f1" }}
              >
                {userName.charAt(0)}
              </div>
            )}
            <div className="flex-1 text-sm text-zinc-600">
              {preview ? "選択した画像のプレビュー" : currentUrl ? "現在のアイコン" : "アイコン未設定"}
            </div>
          </div>
          <div>
            <Label className="text-sm">画像ファイル</Label>
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={onPick}
              disabled={pending}
              className="mt-1"
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex justify-between gap-2 pt-2">
            {currentUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={removeAvatar}
                disabled={pending}
                className="text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                削除
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                キャンセル
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={upload}
                disabled={pending || !file}
              >
                {pending ? "アップロード中..." : "アップロード"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PasswordChangeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, start] = useTransition();

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setSuccess(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (next.length < 8) {
      setError("新しいパスワードは8文字以上で入力してください");
      return;
    }
    if (next !== confirm) {
      setError("新しいパスワードと確認用が一致しません");
      return;
    }
    start(async () => {
      const r = await fetch("/api/auth/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "パスワード変更に失敗しました");
        return;
      }
      setSuccess(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      // 3秒後にダイアログを閉じる
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(false);
      }, 2000);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5">
              <KeyRound className="h-4 w-4" />
            </div>
            パスワード変更
          </DialogTitle>
          <DialogDescription>
            自分自身のログインパスワードを変更します。8文字以上で設定してください。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="current-pw" className="text-sm">現在のパスワード</Label>
            <Input
              id="current-pw"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              disabled={pending || success}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-pw" className="text-sm">新しいパスワード</Label>
            <Input
              id="new-pw"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={pending || success}
            />
            <p className="text-[11px] text-zinc-500">8文字以上推奨。英数字混在を推奨します。</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="confirm-pw" className="text-sm">新しいパスワード（確認）</Label>
            <Input
              id="confirm-pw"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={pending || success}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-start gap-2 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>パスワードを変更しました。</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending || success}>
              {pending ? "変更中..." : "変更する"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
