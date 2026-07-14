// エージェントメイン画面。
// サイドバーの「エージェント」を押すと、このページがそのままエージェントの
// ワークスペースになる（旧: ランディングカード + 別タブで開くボタン、は廃止）。
// - ワークスペース: agent-proxy 経由で非公開 Cloud Run の UI を埋め込み表示
// - 概要: 実行履歴・候補ステータスの概況
// - 候補レビュー: staging 候補の承認/却下/取り込み（変更操作は admin のみ）
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AgentWorkspace } from "@/components/agent/agent-workspace";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const session = await getSession();
  if (!session) redirect("/login?from=/agent");

  const perm = await getCurrentPermission();
  const isAdmin = hasPermission(perm, "admin");
  const proxyConfigured = Boolean(process.env.AGENT_PROXY_URL);

  return <AgentWorkspace proxyConfigured={proxyConfigured} isAdmin={isAdmin} />;
}
