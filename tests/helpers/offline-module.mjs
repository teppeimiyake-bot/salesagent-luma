import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
// 書き込みの 403 の文言（src/lib/write-guard.ts の writeForbidden）。route が import していても、テストが
// 本物（allowed に src/lib/write-guard.ts）もモック（boundaries）も指定していないときに使う。本物の判定は
// tests/write-guard-routes.test.mjs・tests/deal-read-only-ui.test.mjs で確かめる。
const WRITE_GUARD_STUB = `
export const READ_ONLY_MESSAGE = "閲覧のみの権限では、この操作はできません。";
export const CROSS_TENANT_WRITE_MESSAGE = "全社統合ビューでは追加・変更・AIの実行はできません。会社を Luma / リージー のいずれかに切り替えてから操作してください。";
export const writeForbidden = async () => Response.json({ error: READ_ONLY_MESSAGE }, { status: 403 });
export const requireWriter = async () => { throw Error("requireWriter is not mocked in this test"); };`;
// Explicit module boundaries prevent tests from accidentally loading credentials or calling services.
export async function offlineModule(entry, mocks, boundaries, allowed = [entry], external = ["zod", "next/server", "node:path", "node:crypto"]) {
  const permitted = new Set(allowed.map(f => path.join(root, f)));
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
    tsconfigRaw: { compilerOptions: {} }, logLevel: "silent",
    plugins: [{ name: "offline", setup(b) {
      b.onResolve({ filter: /.*/ }, a => {
        if (a.path in boundaries) return { path: a.path, namespace: "mock" };
        if (external.includes(a.path)) return { path: a.path, external: true };
        if (a.path === "@/lib/write-guard" && !permitted.has(path.join(root, "src/lib/write-guard.ts"))) {
          return { path: a.path, namespace: "write-guard-stub" };
        }
        let file = a.path.startsWith("@/") ? path.join(root, "src", a.path.slice(2)) : path.resolve(a.resolveDir || root, a.path);
        if (!/\.[cm]?[jt]sx?$/.test(file)) file += ".ts";
        if (!permitted.has(file)) throw Error("Unexpected dependency: " + a.path);
        return { path: file };
      });
      b.onLoad({ filter: /.*/, namespace: "mock" }, a => ({ contents: boundaries[a.path], loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "write-guard-stub" }, () => ({ contents: WRITE_GUARD_STUB, loader: "js" }));
    } }],
  });
  const loaded = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module: loaded, exports: loaded.exports, mocks, process: { env: mocks.env ?? { NODE_ENV: "development" } },
    Date, Error, URL, Request, Response, File, Blob, FormData, Buffer, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    fetch: () => { throw Error("External network forbidden"); },
    require: n => { if (!external.includes(n)) throw Error("Unexpected require: " + n); return require(n); },
  });
  return loaded.exports;
}
