"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, AlertTriangle, Pencil, Check, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type User = {
  id: string;
  name: string;
  nameKana: string | null;
  email: string;
  role: string | null;
  permission: string;
  avatarColor: string | null;
};

export function UsersAdmin({ initial, currentUserId }: { initial: User[]; currentUserId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState(initial);
  const [pending, start] = useTransition();
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteResult, setDeleteResult] = useState<{
    deals: number;
    documents: number;
    invites: number;
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // インライン編集（メール / 氏名 / フリガナ）
  const [editing, setEditing] = useState<{ id: string; field: "email" | "name" | "nameKana" } | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  function patch(id: string, payload: Record<string, unknown>) {
    start(async () => {
      const r = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.user) {
        setUsers((u) => u.map((x) => (x.id === id ? j.user : x)));
        router.refresh();
      }
    });
  }

  function commitEdit() {
    if (!editing) return;
    const value = draft.trim();
    // フリガナは空でも可（未設定に戻せる）。氏名/メールは空不可。
    if (!value && editing.field !== "nameKana") {
      setEditError("空にはできません");
      return;
    }
    if (editing.field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setEditError("メールアドレスの形式が不正です");
      return;
    }
    setEditError(null);
    const target = editing;
    start(async () => {
      const r = await fetch(`/api/users/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [target.field]: value }),
      });
      const j = await r.json();
      if (!r.ok) {
        setEditError(typeof j.error === "string" ? j.error : "更新に失敗しました");
        return;
      }
      if (j.user) {
        setUsers((u) => u.map((x) => (x.id === target.id ? j.user : x)));
        setEditing(null);
        setDraft("");
        router.refresh();
      }
    });
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
    setEditError(null);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteResult(null);
    const targetId = deleteTarget.id;
    start(async () => {
      const r = await fetch(`/api/users/${targetId}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDeleteError(j.error ?? "削除に失敗しました");
        return;
      }
      setDeleteResult(j.detached ?? { deals: 0, documents: 0, invites: 0 });
      setUsers((u) => u.filter((x) => x.id !== targetId));
      router.refresh();
      // 結果を1.2秒見せてからクローズ
      setTimeout(() => {
        setDeleteTarget(null);
        setDeleteResult(null);
      }, 1200);
    });
  }

  return (
    <>
      <div className="divide-y divide-zinc-100">
        {users.map((u) => {
          const self = u.id === currentUserId;
          return (
            <div key={u.id} className="py-3 flex items-center gap-4">
              <div
                className="w-10 h-10 rounded-full text-white font-bold flex items-center justify-center shadow-sm"
                style={{ background: u.avatarColor ?? "#6366f1" }}
              >
                {u.name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                {/* 氏名（インライン編集） */}
                {editing?.id === u.id && editing.field === "name" ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      className="h-7 text-sm"
                    />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={commitEdit} disabled={pending}>
                      <Check className="w-4 h-4 text-emerald-600" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={cancelEdit} disabled={pending}>
                      <X className="w-4 h-4 text-zinc-500" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group">
                    <p className="font-semibold">{u.name}</p>
                    {self && <Badge variant="secondary">あなた</Badge>}
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-zinc-100"
                      onClick={() => {
                        setEditError(null);
                        setEditing({ id: u.id, field: "name" });
                        setDraft(u.name);
                      }}
                      title="氏名を編集"
                    >
                      <Pencil className="w-3.5 h-3.5 text-zinc-400" />
                    </button>
                  </div>
                )}
                {/* フリガナ（カタカナ・インライン編集。担当者をカナ読みでも検索可能にする） */}
                {editing?.id === u.id && editing.field === "nameKana" ? (
                  <div className="flex items-center gap-1 mt-1">
                    <Input
                      value={draft}
                      autoFocus
                      placeholder="ミヤケテッペイ"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      className="h-7 text-sm"
                    />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={commitEdit} disabled={pending}>
                      <Check className="w-4 h-4 text-emerald-600" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={cancelEdit} disabled={pending}>
                      <X className="w-4 h-4 text-zinc-500" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group">
                    <p className="text-xs text-zinc-400 truncate">
                      フリガナ: {u.nameKana || <span className="italic text-zinc-300">未設定</span>}
                    </p>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-zinc-100 shrink-0"
                      onClick={() => {
                        setEditError(null);
                        setEditing({ id: u.id, field: "nameKana" });
                        setDraft(u.nameKana ?? "");
                      }}
                      title="フリガナ（カタカナ）を編集"
                    >
                      <Pencil className="w-3.5 h-3.5 text-zinc-400" />
                    </button>
                  </div>
                )}
                {/* メール（インライン編集） */}
                {editing?.id === u.id && editing.field === "email" ? (
                  <div className="flex items-center gap-1 mt-1">
                    <Input
                      type="email"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      className="h-7 text-sm"
                    />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={commitEdit} disabled={pending}>
                      <Check className="w-4 h-4 text-emerald-600" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={cancelEdit} disabled={pending}>
                      <X className="w-4 h-4 text-zinc-500" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group">
                    <p className="text-sm text-zinc-500 truncate">{u.email}</p>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-zinc-100 shrink-0"
                      onClick={() => {
                        setEditError(null);
                        setEditing({ id: u.id, field: "email" });
                        setDraft(u.email);
                      }}
                      title="メールアドレスを編集"
                    >
                      <Pencil className="w-3.5 h-3.5 text-zinc-400" />
                    </button>
                  </div>
                )}
                {editError && editing?.id === u.id && (
                  <p className="text-xs text-rose-600 mt-1">{editError}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">役職</span>
                <Select
                  value={u.role ?? "sales"}
                  onValueChange={(v) => patch(u.id, { role: v })}
                >
                  <SelectTrigger className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sales">メンバー</SelectItem>
                    <SelectItem value="manager">マネージャー</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">権限</span>
                <Select
                  value={u.permission}
                  onValueChange={(v) => patch(u.id, { permission: v })}
                  disabled={pending || self}
                >
                  <SelectTrigger className="h-8 w-36">
                    <SelectValue>
                      <Badge
                        variant={
                          u.permission === "admin" ? "danger" : u.permission === "user" ? "info" : "secondary"
                        }
                      >
                        {u.permission === "admin" ? "管理者" : u.permission === "user" ? "利用者" : "閲覧のみ"}
                      </Badge>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">管理者</SelectItem>
                    <SelectItem value="user">利用者</SelectItem>
                    <SelectItem value="viewer">閲覧のみ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-30"
                disabled={self || pending}
                title={self ? "自分自身は削除できません" : "このユーザーを削除"}
                onClick={() => {
                  setDeleteError(null);
                  setDeleteResult(null);
                  setDeleteTarget(u);
                }}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                削除
              </Button>
            </div>
          );
        })}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
            setDeleteResult(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <AlertTriangle className="w-5 h-5" />
              ユーザーの削除
            </DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <span>
                  <strong className="text-zinc-900">{deleteTarget.name}</strong>{" "}
                  さんを削除しますか？
                  <br />
                  関連データ（商談・ドキュメント等の owner）は <code>null</code>{" "}
                  になります。チャット履歴と個人目標は同時に削除されます。この操作は取り消せません。
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-sm rounded border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2">
              {deleteError}
            </div>
          )}
          {deleteResult && (
            <div className="text-sm rounded border border-emerald-200 bg-emerald-50 text-emerald-800 px-3 py-2">
              削除しました。商談 {deleteResult.deals} 件 ／ ドキュメント{" "}
              {deleteResult.documents} 件 ／ 招待 {deleteResult.invites}{" "}
              件のオーナーを切り離し済み。
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={pending}
            >
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={pending || deleteResult !== null}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {pending ? "削除中..." : "削除する"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
