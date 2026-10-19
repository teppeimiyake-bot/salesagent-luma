import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw Error("Provide a temporary output path");
const result = await build({
  absWorkingDir: root, entryPoints: ["tests/fixtures/t02-preview.tsx"], outfile: path.resolve(process.argv[2]),
  bundle: true, format: "iife", platform: "browser", jsx: "automatic", metafile: true,
  alias: { "@": path.join(root, "src") }, define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "offline-navigation", setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "offline" }));
    builder.onLoad({ filter: /.*/, namespace: "offline" }, () => ({
      contents: "export const useRouter = () => ({refresh: () => window.meetTest.refresh()});",
    }));
  } }],
});
if (Object.keys(result.metafile.inputs).some(file => /src\/(?:app\/|lib\/(?:db|google\/|ai\/))/.test(file))) {
  throw Error("Unexpected server dependency");
}
