import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [entry, output] = process.argv.slice(2);
if (!entry?.startsWith("tests/fixtures/") || !output) throw Error("Provide fixture and temporary output");
await build({
  absWorkingDir: root, entryPoints: [entry], outfile: output, bundle: true, format: "iife",
  platform: "browser", jsx: "automatic", alias: { "@": path.join(root, "src"), "react-markdown": path.join(root, ".verification/local-deps/node_modules/react-markdown/index.js") },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "test-router", setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "test" }));
    // Like Next.js, the router instance is stable across renders (effects depending on it do not re-run).
    b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "const router = {refresh(){}};export const useRouter = () => router;" }));
  } }],
});
