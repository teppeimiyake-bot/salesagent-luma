// Builds only the real client component and its local UI dependencies; no app/server runs.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2];
if (!outfile) throw new Error("Usage: node scripts/build-bant-ui-test.mjs <temporary-output.js>");

const result = await build({
  absWorkingDir: root,
  entryPoints: ["tests/fixtures/bant-summary-preview.tsx"],
  outfile: path.resolve(outfile),
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  alias: { "@": path.join(root, "src") },
  define: { "process.env.NODE_ENV": '"development"' },
  metafile: true,
  plugins: [{
    name: "offline-next-navigation",
    setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
        path: "next/navigation",
        namespace: "offline-navigation",
      }));
      builder.onLoad({ filter: /.*/, namespace: "offline-navigation" }, () => ({
        contents: `
          const router = { refresh: () => window.bantTest.refresh() };
          export function useRouter() { return router; }
        `,
      }));
    },
  }],
});

// These shared BANT helpers are pure; provider/DB/server modules remain forbidden.
const pureBantHelpers = new Set([
  "src/lib/ai/bant-definitions.ts",
  "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts",
  "src/lib/ai/timeline-evidence.ts",
]);
const serverInputs = Object.keys(result.metafile.inputs).filter((input) =>
  !pureBantHelpers.has(input) && /(?:^|\/)src\/(?:app\/|lib\/(?:db|storage|ai\/|google\/))/.test(input),
);
if (serverInputs.length) throw new Error(`Unexpected server dependency: ${serverInputs.join(", ")}`);
console.log(`Built offline BANT UI (${Object.keys(result.metafile.inputs).length} client modules).`);
