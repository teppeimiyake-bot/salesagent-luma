import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MeetingDateTimeEditor } from "@/components/deals/meeting-datetime-editor";
import { formatJstMeetingRange, toJstDateStr } from "@/lib/meeting-datetime";

type Demo = { id: string; meetingStartAt: string | null; meetingEndAt: string | null; meetingScheduledAt: string | null };

async function readDemo(): Promise<Demo> {
      const response = await fetch("/demo");
      if (!response.ok) throw Error("データを読み込めませんでした。");
      return (await response.json()).deal;
}

function Preview() {
  const [deal, setDeal] = useState<Demo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => { readDemo().then(deal => {
      setDeal(deal); setError("");
    }).catch(() => setError("データを読み込めませんでした。ページを再読み込みしてください。")); };
    refresh();
    window.addEventListener("t01:refresh", refresh);
    return () => window.removeEventListener("t01:refresh", refresh);
  }, []);
  return <main className="mx-auto max-w-4xl px-6 py-12 text-zinc-800">
    <p className="mb-3 text-sm font-semibold text-orange-700">Luma 開発環境 / T01 手動チェック</p>
    <h1 className="text-3xl font-bold">商談日時の登録</h1>
    <p className="mt-3 text-sm text-zinc-600">架空企業のデモ商談です。変更内容は開発用Neonに保存されます。</p>
    <p className="mt-1 text-sm text-zinc-500">日時登録の確認用ページです。Meet発行・AI呼び出しは含みません。</p>
    {error && <p role="alert" className="my-4 text-red-600">{error}</p>}
    {deal ? <>
      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="mb-5 text-lg font-semibold">商談日時（開始〜終了）</h2>
        <MeetingDateTimeEditor dealId={deal.id} startAt={deal.meetingStartAt} endAt={deal.meetingEndAt} />
      </section>
      <section className="mt-5 rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold">保存済みの表示</h2>
        <p data-testid="saved-range" className="text-lg font-medium">{formatJstMeetingRange(deal.meetingStartAt, deal.meetingEndAt) ?? "未設定"}</p>
        <p className="mt-3 text-sm text-zinc-600">商談予定日：<span data-testid="scheduled-date">{toJstDateStr(deal.meetingScheduledAt) || "未設定"}</span></p>
        <div className="mt-3 text-sm text-zinc-600">閲覧権限の表示：<MeetingDateTimeEditor dealId={deal.id}
          startAt={deal.meetingStartAt} endAt={deal.meetingEndAt} canEdit={false} /></div>
      </section>
      <section className="mt-7 text-sm leading-7 text-zinc-600">
        <h2 className="font-semibold text-zinc-800">確認すること</h2>
        <ol className="ml-5 list-decimal">
          <li>開始日時を入力し、別の場所をクリック。終了は1時間後が補われます。</li>
          <li>終了日時を変更し、ページを再読み込みして保存を確認。</li>
          <li>開始より前の終了日時を入力し、エラーが出て保存されないことを確認。</li>
          <li>日付を変更し、商談予定日も変わることを確認。</li>
          <li>「クリア」で未設定に戻ることを確認。</li>
        </ol>
      </section>
    </> : <p className="mt-8">読み込み中…</p>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
