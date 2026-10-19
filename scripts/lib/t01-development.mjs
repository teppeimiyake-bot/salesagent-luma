// Development-only harness: actual routes and tenant extension, isolated demo context.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { parse } from "dotenv";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const entries = { db: "src/lib/db.ts", route: "src/app/api/deals/[id]/route.ts" };
const allowed = new Set([
  ...Object.values(entries), "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/bant-definitions.ts", "src/lib/ai/timeline-evidence.ts",
  "src/components/deals/bant-summary-utils.ts", "src/lib/meeting-datetime.ts",
  "src/lib/meetings/meeting-owner.ts", "src/lib/deal-title.ts",
  // 書き込みの 403 の文言（writeForbidden）。auth・tenant-context は下の boundaries の差し替えを使う。
  "src/lib/write-guard.ts",
].map(file => path.join(root, file)));
const externals = new Set(["zod", "pg", "@prisma/adapter-pg", "next/server"]);
const boundaries = {
  "@/lib/db": "export const prisma = globalThis.dependencies.prisma;",
  "@prisma/client": "module.exports = globalThis.dependencies.generated;",
  "@/lib/tenant-context": `
    export const currentTenant = () => globalThis.dependencies.context;
    export const getRequestTenant = async () => globalThis.dependencies.context;`,
  "@/lib/auth": `
    export const getCurrentPermission = async () => globalThis.dependencies.permission;
    // write-guard.ts の requireWriter 用（deals/[id] は writeForbidden だけを使うので呼ばれない）
    export const getSession = async () => { throw Error("getSession is not used by this route"); };
    export const hasPermission = (actual, required) =>
      ({viewer:1,user:2,admin:3}[actual] ?? 0) >= ({viewer:1,user:2,admin:3}[required] ?? Infinity);`,
  "@/lib/notion-sync": "export const syncDealAppointmentDateToNotion = () => { throw Error('EXTERNAL_CALL_FORBIDDEN'); };",
};

export async function bundleT01Sources() {
  const compiled = {};
  for (const [name, file] of Object.entries(entries)) {
    const result = await build({
      absWorkingDir: root, entryPoints: [file], bundle: true, write: false,
      format: "cjs", platform: "node", logLevel: "silent", tsconfigRaw: { compilerOptions: {} },
      plugins: [{ name: "t01-development-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path in boundaries) return { path: args.path, namespace: "boundary" };
          if (externals.has(args.path)) return { path: args.path, external: true };
          let resolved = args.path.startsWith("@/") ? path.join(root, "src", args.path.slice(2))
            : path.resolve(args.resolveDir || root, args.path);
          if (!resolved.endsWith(".ts")) resolved += ".ts";
          if (!allowed.has(resolved)) throw Error("DEPENDENCY_NOT_ALLOWED");
          return { path: resolved };
        });
        builder.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents: boundaries[args.path], loader: "js" }));
      } }],
    });
    compiled[name] = result.outputFiles[0].text;
  }
  return compiled;
}

export function loadSource(compiled, name, dependencies) {
  const loaded = { exports: {} };
  vm.runInNewContext(compiled[name], {
    module: loaded, exports: loaded.exports, dependencies,
    prisma: dependencies.base, pool: dependencies.pool, Date, TextDecoder, Request, Response,
    process: { env: { NODE_ENV: "test", TENANT_STRICT: "1", DATABASE_URL: "development-cache-only" } },
    console: { log() {}, warn() {}, error() {} },
    require: name => {
      if (!externals.has(name)) throw Error("RUNTIME_DEPENDENCY_NOT_ALLOWED");
      return require(name);
    },
    fetch: () => { throw Error("EXTERNAL_CALL_FORBIDDEN"); },
  });
  return loaded.exports;
}

export function newFixture() {
  return { tenant: randomUUID(), company: randomUUID(), deal: randomUUID(), tag: `t01-demo-${randomUUID()}` };
}

export async function connectDevelopment(compiled, fixture) {
  if (!process.execArgv.includes("--use-system-ca")) throw Error("SYSTEM_CA_FLAG_REQUIRED");
  // User confirmed this existing connection is development-only. Never log the URL.
  const value = parse(readFileSync(path.join(root, "../platform/.env"))).DATABASE_URL;
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/i.test(url.hostname)
    || (url.port && url.port !== "5432") || !url.username || !url.password || url.pathname.length < 2) {
    throw Error("DEVELOPMENT_DATABASE_CONNECTION_REJECTED");
  }
  url.search = "";
  url.hash = "";
  url.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
  pool.on("error", () => { process.stderr.write("DEVELOPMENT_DATABASE_CONNECTION_ERROR\n"); });
  const generated = require(path.join(root, ".verification/generated/client/index.js"));
  const base = new generated.PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  const dependencies = { base, pool, generated, permission: "user", prisma: undefined,
    context: { tenantId: fixture.tenant, code: fixture.tag, fiscalYearStartMonth: 1,
      userId: "t01-demo-only", permission: "user", crossTenant: false } };
  const { prisma } = loadSource(compiled, "db", dependencies);
  dependencies.prisma = prisma;
  return { prisma, base, dependencies, route: loadSource(compiled, "route", dependencies),
    async close() { await base.$disconnect(); await pool.end(); } };
}

export async function seedFixture(prisma, fixture) {
  await prisma.tenant.create({ data: { id: fixture.tenant, code: fixture.tag,
    name: "T01手動確認用デモ", shortName: "T01デモ" } });
  await prisma.company.create({ data: { id: fixture.company, name: "架空企業・商談日時テスト",
    note: fixture.tag, createdByTenantId: fixture.tenant } });
  await prisma.deal.create({ data: { id: fixture.deal, companyId: fixture.company,
    title: "T01 商談日時の確認（デモ）" } });
}

export async function assertFixture(prisma, fixture) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
  if (![fixture.tenant, fixture.company, fixture.deal].every(id => uuid.test(id))
    || !/^t01-demo-[0-9a-f-]{36}$/.test(fixture.tag)) throw Error("INVALID_DEMO_FIXTURE");
  const tenant = await prisma.tenant.findUnique({ where: { id: fixture.tenant } });
  const deal = await prisma.deal.findUnique({ where: { id: fixture.deal }, include: { company: true } });
  if (tenant?.code !== fixture.tag || deal?.companyId !== fixture.company
    || deal?.company.note !== fixture.tag || deal.company.createdByTenantId !== fixture.tenant) {
    throw Error("DEMO_FIXTURE_MISMATCH");
  }
}

export function routeRequest(route, fixture, body) {
  const req = new Request(`http://t01.invalid/api/deals/${fixture.deal}`, body === undefined ? {} : {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return route[body === undefined ? "GET" : "PATCH"](req, { params: Promise.resolve({ id: fixture.deal }) });
}
