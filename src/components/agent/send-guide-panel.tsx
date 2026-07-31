"use client";
// エージェント「使い方」タブ。
// 営業台帳 (GAS送信パネル) からメールを1通ずつ自動送信する手順を、
// エンドユーザー向けに図解する静的ガイド。デザインはワークスペースと同じ
// モノトーン基調 (zinc + 最小限の emerald/amber アクセント)。
import {
  BookOpen,
  CheckSquare,
  Play,
  Timer,
  CheckCircle2,
  ShieldCheck,
  Ban,
  Gauge,
  FlaskConical,
  Users,
  ExternalLink,
  Table2,
  AlertTriangle,
  PauseCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------ 小さな部品 ------------------------------ */

function WhoChip({ who }: { who: "you" | "auto" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide",
        who === "you"
          ? "bg-zinc-900 text-white"
          : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
      )}
    >
      {who === "you" ? "あなた" : "自動"}
    </span>
  );
}

function StatusChip({ label }: { label: string }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-md bg-zinc-100 px-2 py-0.5 text-[12px] font-semibold text-zinc-700">
      {label}
    </span>
  );
}

function NumBadge({ n, dark }: { n: number; dark?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
        dark ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700",
      )}
    >
      {n}
    </span>
  );
}

/* ------------------------------- 本体 ------------------------------- */

export function SendGuidePanel({ ledgerUrl }: { ledgerUrl: string }) {
  const flowSteps: {
    who: "you" | "auto";
    title: string;
    desc: React.ReactNode;
  }[] = [
    {
      who: "you",
      title: "文面を確認してチェック",
      desc: (
        <>
          営業台帳のメール件名・本文を読んで、送ってよい行の
          <b className="text-zinc-900"> K列「送信Flag」にチェック</b>
        </>
      ),
    },
    {
      who: "you",
      title: "「▶ 送信開始」を押す",
      desc: (
        <>
          シート右側の<b className="text-zinc-900">送信パネル</b>
          （またはメニュー「📨 Reeasy営業」→「▶ 送信開始」）から開始
        </>
      ),
    },
    {
      who: "auto",
      title: "1通ずつ自動送信",
      desc: (
        <>
          チェックした行が「送信予約」になり、
          <b className="text-zinc-900">30〜60秒間隔</b>で1通ずつ配信。
          シートを閉じても継続
        </>
      ),
    },
    {
      who: "auto",
      title: "結果が台帳に残る",
      desc: (
        <>
          送れた行はL列が「送信済み」に。1通ごとの記録は
          <b className="text-zinc-900">「送信履歴」シート</b>へ
        </>
      ),
    },
  ];

  const guards = [
    {
      icon: FlaskConical,
      title: "テストモード",
      desc: "DRY_RUN=true の間は何度開始しても実際のメールは送られない。まずここで動きを確認",
    },
    {
      icon: Timer,
      title: "送信ペース",
      desc: "1通ごとに30〜60秒のランダム間隔。まとめ送りをしないので迷惑メール（Bot）判定を受けにくい",
    },
    {
      icon: Gauge,
      title: "1日の上限",
      desc: "設定した日次上限とGmailの残り枠を毎回チェックし、達したら自動停止。翌日に再開できる",
    },
    {
      icon: Ban,
      title: "重複・除外",
      desc: "除外リスト一致、同じ会社への二重送信、同一ドメインへの7日以内の連続送信は自動スキップ",
    },
    {
      icon: Users,
      title: "グループメール確認",
      desc: "送信元アドレスがGmailに未登録なら本番送信を開始せず、設定手順を案内",
    },
  ];

  const statuses = [
    { label: "未送信", mean: "まだ何もしていない行", action: "文面を確認してK列にチェック" },
    { label: "送信予約", mean: "送信待ちの列に並んでいる", action: "待つだけ。やめたい行はメニューから予約取り消し" },
    { label: "送信済み", mean: "配信完了", action: "なし（同じ会社に二重送信されない）" },
    { label: "失敗", mean: "アドレス不正・本文なし等（理由はS列に記録）", action: "内容を直して再度K列にチェック" },
    { label: "対象外", mean: "除外リスト一致・過去に送信済みなど", action: "基本そのままでOK" },
  ];

  const troubles = [
    {
      q: "送信パネルが表示されない",
      a: "台帳のメニュー「📨 Reeasy営業」→「📊 送信パネルを開く」。初回は承認画面が出るので許可する（以後は自動表示）。開けなくてもメニューの「▶ 送信開始」「⏹ 送信停止」で同じ操作ができる",
    },
    {
      q: "「送信が止まっている可能性」と警告が出た",
      a: "パネルに表示される「▶ 送信を再開する」を押す（ジョブを開始した本人のアカウントで）",
    },
    {
      q: "今すぐ全部止めたい",
      a: "パネルの「⏹ 停止」。効かない場合はメニュー「詳細・診断」→「送信トリガーを全て削除する (緊急停止)」",
    },
    {
      q: "失敗が続く・様子がおかしい",
      a: "「実行ログ」「送信履歴」シートを確認。失敗があると担当者宛てに通知メールも届く",
    },
  ];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* ヘッダー */}
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-900">
            <BookOpen className="h-5 w-5 text-zinc-400" />
            メール自動送信の使い方
          </h2>
          <p className="mt-1 text-[13px] text-zinc-500">
            営業台帳（スプレッドシート）から、営業メールを1通ずつ安全に自動送信する手順
          </p>
        </div>
        <a
          href={ledgerUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-zinc-700"
        >
          <Table2 className="h-3.5 w-3.5" />
          営業台帳を開く
          <ExternalLink className="h-3 w-3 text-zinc-400" />
        </a>
      </div>

      {/* やることは2つだけ */}
      <div className="mb-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="mb-4 text-[11px] font-bold uppercase tracking-widest text-zinc-400">
          やることは2つだけ
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 shadow-sm">
              <CheckSquare className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-zinc-900">
                1. K列「送信Flag」にチェック
              </div>
              <div className="mt-0.5 text-[13px] leading-relaxed text-zinc-500">
                件名・本文を確認して、送ってよい会社の行にチェックを入れる
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 shadow-sm">
              <Play className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-zinc-900">
                2. 「▶ 送信開始」を押す
              </div>
              <div className="mt-0.5 text-[13px] leading-relaxed text-zinc-500">
                あとは全部自動。1通ずつ間隔を空けて送信され、進捗はパネルに流れる
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-[13px] font-medium text-emerald-800 ring-1 ring-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          シートやPCを閉じても送信は続きます。止めたいときだけパネルの「⏹ 停止」を押してください。
        </div>
      </div>

      {/* 全体の流れ */}
      <div className="mb-8">
        <h3 className="mb-3 text-[15px] font-bold tracking-tight text-zinc-900">全体の流れ</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {flowSteps.map((s, i) => (
            <div
              key={s.title}
              className={cn(
                "relative rounded-2xl border p-4 shadow-sm",
                s.who === "you"
                  ? "border-zinc-300 bg-white"
                  : "border-emerald-200 bg-emerald-50/40",
              )}
            >
              <div className="mb-2 flex items-center justify-between">
                <NumBadge n={i + 1} dark={s.who === "you"} />
                <WhoChip who={s.who} />
              </div>
              <div className="text-[13.5px] font-semibold text-zinc-900">{s.title}</div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 送信パネルの見方 */}
      <div className="mb-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h3 className="mb-1 text-[15px] font-bold tracking-tight text-zinc-900">
          送信パネルの見方
        </h3>
        <p className="mb-5 text-[13px] text-zinc-500">
          営業台帳を開くと右側に自動表示されます（出ないときはメニュー「📨 Reeasy営業」→「📊 送信パネルを開く」）
        </p>
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* モックアップ */}
          <div className="w-full max-w-[280px] shrink-0 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-[12px] shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-bold text-zinc-900">送信パネル</span>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                ① テスト送信モード
              </span>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-1.5">
              {[
                ["12", "② 送信予約中"],
                ["3", "✔チェック済"],
                ["8", "③ 本日送信 / 200"],
                ["1482", "Gmail残枠"],
              ].map(([v, l]) => (
                <div
                  key={l}
                  className="rounded-lg border border-zinc-200 bg-white px-1 py-1.5 text-center"
                >
                  <div className="text-[15px] font-bold tabular-nums text-zinc-900">{v}</div>
                  <div className="text-[9px] text-zinc-500">{l}</div>
                </div>
              ))}
            </div>
            <div className="mb-3 rounded-lg bg-zinc-900 py-2 text-center text-[12px] font-bold text-white">
              ④ ▶ 送信開始 (対象 15件)
            </div>
            <div className="border-t border-zinc-200 pt-2 text-[10px] font-bold text-zinc-500">
              ⑤ 進捗フィード
            </div>
            <div className="mt-1 space-y-1 text-[10.5px] text-zinc-500">
              <div className="text-emerald-700">✓ 10:42 株式会社サンプル に送信しました</div>
              <div className="text-emerald-700">✓ 10:41 △△工業 に送信しました</div>
              <div>− 10:40 □□商事 対象外: 除外リスト一致</div>
            </div>
          </div>
          {/* 凡例 */}
          <ol className="flex-1 space-y-3.5 text-[13.5px] leading-relaxed">
            {[
              [
                "モードバッジ",
                "緑「テスト送信」なら実際には送られない（練習・確認用）。赤「⚠ 本番送信」のときだけ実際に配信される。切替は台帳の「設定」シートの DRY_RUN（true=テスト / false=本番）",
              ],
              ["件数", "いま送信待ちの行数と、K列チェック済みでまだ予約されていない行数"],
              [
                "本日の送信数と残り枠",
                "1日の上限とGmail側の残り枠。上限に達すると自動で止まり、翌日に再開できる",
              ],
              [
                "送信開始 / 停止ボタン",
                "開始後は「⏹ 停止」に変わる。停止しても処理済みの行はそのまま、残りは「送信予約」のまま待機",
              ],
              ["進捗フィード", "1通送るごとに会社名が流れる。✓=送信 / −=対象外 / ✗=失敗"],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-2.5">
                <NumBadge n={i + 1} dark />
                <div>
                  <span className="font-semibold text-zinc-900">{t}</span>
                  <span className="text-zinc-500"> — {d}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* 自動で守られていること */}
      <div className="mb-8">
        <h3 className="mb-3 flex items-center gap-1.5 text-[15px] font-bold tracking-tight text-zinc-900">
          <ShieldCheck className="h-4 w-4 text-zinc-400" />
          自動で守られていること
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {guards.map((g) => {
            const Icon = g.icon;
            return (
              <div key={g.title} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100">
                    <Icon className="h-4 w-4 text-zinc-600" />
                  </div>
                  <div className="text-[13.5px] font-semibold text-zinc-900">{g.title}</div>
                </div>
                <div className="text-[12.5px] leading-relaxed text-zinc-500">{g.desc}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800 ring-1 ring-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b>本番送信に切り替える前に:</b>{" "}
            必ずテストモードで一度動きを確認し、切替は台帳の「設定」シートの DRY_RUN を false
            に変更してください。本番開始時は確認ダイアログが2回表示されます。
          </span>
        </div>
      </div>

      {/* ステータスの意味 */}
      <div className="mb-8 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-5 py-3.5">
          <h3 className="text-[15px] font-bold tracking-tight text-zinc-900">
            L列「メール送信状態」の意味
          </h3>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-[11px] uppercase tracking-wider text-zinc-400">
              <th className="px-5 py-2.5 font-semibold">表示</th>
              <th className="px-3 py-2.5 font-semibold">意味</th>
              <th className="px-5 py-2.5 font-semibold">あなたがやること</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.label} className="border-b border-zinc-50 last:border-0">
                <td className="px-5 py-2.5">
                  <StatusChip label={s.label} />
                </td>
                <td className="px-3 py-2.5 text-zinc-600">{s.mean}</td>
                <td className="px-5 py-2.5 text-zinc-500">{s.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 困ったとき */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h3 className="mb-4 flex items-center gap-1.5 text-[15px] font-bold tracking-tight text-zinc-900">
          <PauseCircle className="h-4 w-4 text-zinc-400" />
          困ったとき
        </h3>
        <div className="space-y-4">
          {troubles.map((t) => (
            <div key={t.q}>
              <div className="text-[13.5px] font-semibold text-zinc-900">Q. {t.q}</div>
              <div className="mt-0.5 text-[13px] leading-relaxed text-zinc-500">A. {t.a}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
