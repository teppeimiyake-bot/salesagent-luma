"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, FileText, Download } from "lucide-react";
import { formatDate } from "@/lib/utils";

type Doc = {
  id: string;
  name: string;
  description: string | null;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: Date | string;
  uploadedBy: { name: string } | null;
};

export function DocumentList({ docs, canEdit = true }: { docs: Doc[]; canEdit?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function remove(id: string) {
    if (!confirm("削除しますか？")) return;
    start(async () => {
      await fetch(`/api/documents/${id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  return (
    <ul className="divide-y divide-zinc-100">
      {docs.map((d) => (
        <li key={d.id} className="px-5 py-3 flex items-center gap-3 hover:bg-zinc-50">
          <div className="rounded-md bg-zinc-100 p-2">
            <FileText className="h-4 w-4 text-zinc-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{d.name}</p>
            {d.description && <p className="text-xs text-zinc-500 truncate">{d.description}</p>}
            <p className="text-[10px] text-zinc-400 mt-0.5">
              {d.uploadedBy?.name ?? "—"} ／ {formatDate(d.createdAt)}
              {d.fileSize && ` ／ ${(d.fileSize / 1024).toFixed(0)} KB`}
            </p>
          </div>
          {d.fileUrl.startsWith("/uploads/") ? (
            <a
              href={d.fileUrl}
              download
              className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"
            >
              <Download className="h-3.5 w-3.5" /> ダウンロード
            </a>
          ) : (
            <span className="text-xs text-zinc-400">未アップロード</span>
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
  );
}
