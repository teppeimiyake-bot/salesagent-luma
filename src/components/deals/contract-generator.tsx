"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileSignature, Wand2 } from "lucide-react";

type DealProductLite = {
  id: string;
  productName: string;
  planName: string | null;
  category: "映像" | "SNS" | "CATV" | "アライアンス" | null;
  amount: number | null;
  yomiStatus: string | null;
};

/**
 * 契約書 自動生成（機能②）のUI。
 *   映像/SNS の DealProduct ごとに「契約書を生成」ボタンを出す。
 *   A+ヨミ遷移時は API 側で自動生成されるが、ここから手動でも生成できる。
 *   生成された契約書ドラフトは下の「この商談の個別契約書」セクションに表示される。
 */
export function ContractGenerator({
  dealProducts,
  canEdit,
}: {
  dealProducts: DealProductLite[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 映像/SNS のみ契約書テンプレ対応
  const targets = dealProducts.filter((d) => d.category === "映像" || d.category === "SNS");

  if (!canEdit || targets.length === 0) return null;

  async function generate(id: string, force = false) {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/deal-products/${id}/contract${force ? "?force=1" : ""}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        setMsg(j.error ?? "生成に失敗しました");
      } else if (j.skipped) {
        setMsg("既にこの商材の契約書ドラフトがあります（重複生成を防止しました）。下の「個別契約書」を確認してください。");
      } else {
        setMsg(`✓ ${j.category}契約書ドラフトを生成しました。下の「個別契約書」に表示されます。`);
      }
      router.refresh();
      setTimeout(() => setMsg(null), 5000);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="border-amber-200 bg-gradient-to-br from-amber-50/40 via-white to-orange-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white p-1.5 shadow-sm">
            <FileSignature className="h-4 w-4" />
          </div>
          契約書 自動生成
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-zinc-500 mb-3">
          映像・SNS の商材は雛形から契約書ドラフトを自動生成できます。
          ヨミが <span className="font-medium">A+ヨミ</span> になった時点でも自動生成されます（重複は生成しません）。
        </p>
        {msg && <p className="text-xs text-amber-800 bg-amber-50 px-3 py-2 rounded mb-3">{msg}</p>}
        <ul className="space-y-2">
          {targets.map((dp) => (
            <li key={dp.id} className="flex items-center gap-3 p-2 rounded-md border border-amber-100 bg-white">
              <Badge variant={dp.category === "映像" ? "warning" : "info"} className="text-[10px] shrink-0">
                {dp.category}
              </Badge>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {[dp.productName, dp.planName].filter(Boolean).join(" / ")}
                </p>
                <p className="text-[11px] text-zinc-400">
                  {dp.amount ? `¥${dp.amount.toLocaleString("ja-JP")}（税抜）` : "金額未設定"}
                  {dp.yomiStatus ? ` ／ ${dp.yomiStatus}` : ""}
                </p>
              </div>
              <Button size="sm" variant="primary" disabled={busyId === dp.id} onClick={() => generate(dp.id)}>
                <Wand2 className="h-3.5 w-3.5" />
                {busyId === dp.id ? "生成中..." : "契約書を生成"}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
