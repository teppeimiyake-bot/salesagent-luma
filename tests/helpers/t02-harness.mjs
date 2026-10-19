// Real T02 library/route with only Google, auth and DB boundaries replaced.
import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const allowed = new Set(["src/lib/google/meet.ts", "src/lib/feature-flags.ts",
  "src/app/api/deals/[id]/meet/route.ts"].map(file => path.join(root, file)));
const externals = new Set(["crypto", "zod", "next/server"]);
const boundaries = {
  googleapis: `export const google = {
    auth: { OAuth2: class { setCredentials() {} } },
    calendar: () => globalThis.mocks.calendar,
  };`,
  "@/lib/db": "export const prisma = globalThis.mocks.prisma;",
  "@/lib/auth": `export const getSession = async () => globalThis.mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};
    export const hasPermission = actual => ['user', 'admin'].includes(actual);`,
  "@/lib/meetings/meet-ingest": "export const configureDealMeetArtifacts = globalThis.mocks.configureArtifacts;",
  // 書き込みの 403 の文言（src/lib/write-guard.ts の writeForbidden と同じ閲覧のみの理由）
  "@/lib/write-guard": `export const writeForbidden = async () =>
    Response.json({ error: "閲覧のみの権限では、この操作はできません。" }, { status: 403 });`,
};
let bundle;
export async function loadT02(mocks) {
  bundle ??= build({
    absWorkingDir: root,
    stdin: { contents: `export * as meet from './src/lib/google/meet.ts';
      export * as route from './src/app/api/deals/[id]/meet/route.ts';`, resolveDir: root, loader: "ts" },
    bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
    tsconfigRaw: { compilerOptions: {} },
    plugins: [{ name: "t02-offline-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path in boundaries) return { path: args.path, namespace: "boundary" };
        if (externals.has(args.path)) return { path: args.path, external: true };
        let resolved = args.path.startsWith("@/") ? path.join(root, "src", args.path.slice(2))
          : path.resolve(args.resolveDir || root, args.path);
        if (!resolved.endsWith(".ts")) resolved += ".ts";
        if (!allowed.has(resolved)) throw Error("T02_UNEXPECTED_DEPENDENCY");
        return { path: resolved };
      });
      builder.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents: boundaries[args.path], loader: "js" }));
    } }],
  }).then(result => result.outputFiles[0].text);
  const loaded = { exports: {} };
  vm.runInNewContext(await bundle, {
    module: loaded, exports: loaded.exports, mocks,
    process: { env: mocks.env }, Date, Error, URL, Request, Response,
    require: name => { if (!externals.has(name)) throw Error("T02_UNEXPECTED_REQUIRE"); return require(name); },
    fetch: () => { throw Error("EXTERNAL_NETWORK_FORBIDDEN"); },
  });
  return loaded.exports;
}

export function fakeEnv() {
  return { FEATURE_MEET: "1", GOOGLE_MEET_CLIENT_ID: "test-only", GOOGLE_MEET_CLIENT_SECRET: "test-only",
    GOOGLE_MEET_REFRESH_TOKEN: "test-only" };
}

export const ready = (id = "demoevent") => ({ id, hangoutLink: "https://meet.google.com/abc-defg-hij" });
export const pending = id => ({ id, conferenceData: { createRequest: { status: { statusCode: "pending" } } } });
export function postMeet(route, id, body = {}) {
  return route.POST(new Request("http://offline.invalid", { method: "POST",
    headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  { params: Promise.resolve({ id }) });
}
