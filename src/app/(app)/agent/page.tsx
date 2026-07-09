// 営業リスト作成エージェント（Cloud Run）への導線ページ（Phase 2）。
// iframe 埋め込みは IAP のログイン（accounts.google.com）が iframe 内で表示できず
// 成立しないため、外部リンク（新規タブで開く）方式にする（クラウド移行計画書の推奨）。
// 開き先は環境変数 NEXT_PUBLIC_AGENT_URL（IAP 保護された Cloud Run の URL）。

import { Bot, ExternalLink } from "lucide-react";
import { Header } from "@/components/layout/header";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL;

export default function AgentPage() {
  return (
    <>
      <Header
        title="エージェント"
        subtitle="営業リスト作成エージェント（Cloud Run）"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <div className="max-w-xl mx-auto mt-10">
          <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50">
              <Bot className="h-7 w-7 text-indigo-500" />
            </div>
            <h2 className="text-lg font-semibold text-zinc-800">
              営業リスト作成エージェント
            </h2>
            <p className="mt-2 text-sm text-zinc-500">
              会社リストの生成・公式HP解決・連絡先/フォーム抽出・文面生成を行う
              エージェントを、別タブで開きます（Google アカウントでのログインが必要です）。
            </p>

            {AGENT_URL ? (
              <a
                href={AGENT_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-6 inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 px-5 py-2.5 text-sm font-semibold text-white shadow hover:from-orange-600 hover:to-amber-600"
              >
                エージェントを開く
                <ExternalLink className="h-4 w-4" />
              </a>
            ) : (
              <div className="mt-6 rounded-lg bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-500">
                エージェントURLが未設定です。環境変数{" "}
                <code className="px-1 py-0.5 rounded bg-zinc-100">
                  NEXT_PUBLIC_AGENT_URL
                </code>{" "}
                を設定してください。
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
