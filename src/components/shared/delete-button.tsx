"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Variant = "icon" | "button";

interface Props {
  /** 削除対象のAPIパス（DELETE される）。例: "/api/deals/<id>" "/api/companies/<id>" */
  endpoint: string;
  /** ダイアログ内に表示する対象名（例: 「Acme株式会社」「商談タイトル」） */
  targetLabel: string;
  /** ダイアログ補足（例: 「この企業に紐づく商談 3 件もまとめて...」） */
  extraNote?: string;
  /** 削除完了後の遷移先（指定がなければ router.refresh()） */
  redirectTo?: string;
  /** 表示形式：アイコンだけ（一覧の行内）か通常ボタン（詳細ヘッダ） */
  variant?: Variant;
  /** ボタン上のテキスト（variant="button" 時） */
  label?: string;
  /** stopPropagationして親のLink遷移を抑止（一覧の行内クリック時に必要） */
  stopPropagation?: boolean;
  className?: string;
}

export function DeleteButton({
  endpoint,
  targetLabel,
  extraNote,
  redirectTo,
  variant = "icon",
  label = "削除",
  stopPropagation = true,
  className,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function openDialog(e: React.MouseEvent) {
    if (stopPropagation) {
      e.preventDefault();
      e.stopPropagation();
    }
    setError(null);
    setOpen(true);
  }

  async function confirmDelete() {
    setError(null);
    start(async () => {
      try {
        const r = await fetch(endpoint, { method: "DELETE" });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error ?? `削除に失敗しました（${r.status}）`);
          return;
        }
        setOpen(false);
        if (redirectTo) {
          router.push(redirectTo);
        }
        router.refresh();
      } catch {
        setError("通信エラーが発生しました");
      }
    });
  }

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={openDialog}
          title="削除"
          className={cn(
            "shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-500 transition-colors",
            className,
          )}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openDialog}
          className={cn(
            "border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300",
            className,
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {label}
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              削除しますか？
            </DialogTitle>
            <DialogDescription className="pt-1 text-base text-zinc-700">
              <span className="font-semibold text-zinc-900">{targetLabel}</span>{" "}
              をゴミ箱に移動します。
              <br />
              <span className="text-sm text-zinc-500">
                ゴミ箱からは管理者が「復元」または「完全削除」できます。
              </span>
            </DialogDescription>
          </DialogHeader>

          {extraNote && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
              <AlertTriangle className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5" />
              {extraNote}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDelete}
              disabled={pending}
            >
              {pending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  削除中...
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  ゴミ箱へ移動
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
