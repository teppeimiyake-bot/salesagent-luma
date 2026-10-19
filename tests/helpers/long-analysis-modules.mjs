// T04/T22: 長い記録の分析（原文抜粋）の純関数モジュール。analysis.ts・status-payload.ts を含むテストは
// offlineModule の allowed にこれを足して実物を使う（DB・AI・外部通信には触れない）。
export const LONG_ANALYSIS_PURE_MODULES = [
  "src/lib/meetings/long-analysis-job.ts",
  "src/lib/ai/long-transcript.ts",
  "src/lib/ai/timeline-evidence.ts",
  "src/lib/ai/bant-definitions.ts",
  "src/lib/ai/bant-withdrawal.ts",
  "src/lib/ai/causal-evidence.ts",
  "src/lib/ai/issue-evidence.ts",
  "src/lib/ai/customer-conditions.ts",
];
