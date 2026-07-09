// 営業リスト作成エージェント（Cloud Run）を iframe 埋め込みで表示するページ。
// 重処理・進捗・成果物はすべて Cloud Run 側。ここは表示導線のみ（Phase 2）。
// 埋め込み先は環境変数 NEXT_PUBLIC_AGENT_URL（ローカルは proxy の http://localhost:8080）。

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL;

export default function AgentPage() {
  if (!AGENT_URL) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-zinc-700 font-semibold mb-1">エージェントURLが未設定です</p>
          <p className="text-sm text-zinc-500">
            環境変数{" "}
            <code className="px-1 py-0.5 rounded bg-zinc-100">NEXT_PUBLIC_AGENT_URL</code>{" "}
            を設定してください（ローカルは{" "}
            <code className="px-1 py-0.5 rounded bg-zinc-100">http://localhost:8080</code>）。
          </p>
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={AGENT_URL}
      title="営業リスト作成エージェント"
      className="flex-1 w-full border-0"
    />
  );
}
