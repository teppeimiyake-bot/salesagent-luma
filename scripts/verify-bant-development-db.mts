/**
 * Development Neon integration check: real route handlers, tenant extension and DB.
 * AI is deterministic; no HTTP server, authentication flow or external AI is exercised.
 * All fixture writes run in one transaction which MUST roll back, including on failure.
 *
 * node --use-system-ca --import tsx scripts/verify-bant-development-db.mts
 * Add --check-only to validate the source bundles without reading a URL or connecting.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "dotenv";
import { build } from "esbuild";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { Prisma, PrismaClient } from "../.verification/generated/client/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRequire = createRequire(import.meta.url);
const entries = {
  db: "src/lib/db.ts",
  route: "src/app/api/deals/[id]/route.ts",
  aggregate: "src/lib/ai/summarize-bant.ts",
  cards: "src/components/deals/bant-summary-utils.ts",
};
const allowedFiles = new Set([
  ...Object.values(entries),
  "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/bant-definitions.ts",
  "src/lib/ai/luma-context.ts", "src/lib/ai/luma-value-proposition.ts",
  "src/lib/meeting-datetime.ts", "src/lib/meetings/meeting-owner.ts",
  "src/lib/deal-title.ts",
  "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/vertex-policy.ts",
  // summarize-bant.ts は入力の上限に合わせて縮めるかを getHeavyTextProvider() で決める（環境変数を読むだけで外部には出ない）。
  "src/lib/ai/provider.ts",
].map(file => path.join(root, file)));
const externals = new Set(["node:crypto", "zod", "pg", "@prisma/adapter-pg", "next/server"]);
const boundaries: Record<string, string> = {
  "@/lib/db": "export const prisma = globalThis.dependencies.prisma;",
  "@prisma/client": "module.exports = globalThis.dependencies.generated;",
  "@/lib/tenant-context": `
    export const currentTenant = () => globalThis.dependencies.context;
    export const getRequestTenant = async () => globalThis.dependencies.context;`,
  "@/lib/ai/anthropic": `
    export const callClaudeHeavyJSON = globalThis.dependencies.generate;
    export const buildSystemText = ({ system, cacheableSystem }) => {
      const cacheable = cacheableSystem?.trim();
      return cacheable ? cacheable + "\\n\\n" + system : system;
    };`,
  "@/lib/auth": `
    export const getCurrentPermission = async () => 'user';
    export const hasPermission = () => true;`,
  "@/lib/notion-sync": `
    export const syncDealAppointmentDateToNotion = () => globalThis.dependencies.forbidden();`,
};

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
let assertions = 0;
function check(value: unknown, code: string): void {
  assertions++;
  if (!value) fail(code);
}
function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "VERIFICATION_FAILED";
}
function report(code: string) {
  process.stdout.write(`${code}\n`);
}

async function bundleSources() {
  const compiled: Partial<Record<keyof typeof entries, string>> = {};
  for (const [kind, relative] of Object.entries(entries)) {
    const result = await build({
      absWorkingDir: root, entryPoints: [path.join(root, relative)],
      bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
      tsconfigRaw: { compilerOptions: {} },
      plugins: [{ name: "development-verification-allowlist", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path in boundaries) return { path: args.path, namespace: "boundary" };
          if (externals.has(args.path)) return { path: args.path, external: true };
          let resolved = args.path.startsWith("@/")
            ? path.join(root, "src", args.path.slice(2))
            : path.resolve(args.resolveDir || root, args.path);
          if (!resolved.endsWith(".ts")) resolved += ".ts";
          if (!allowedFiles.has(resolved)) fail("DEPENDENCY_NOT_ALLOWED");
          return { path: resolved };
        });
        builder.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({
          contents: boundaries[args.path], loader: "js",
        }));
      } }],
    }).catch((error: unknown) => {
      // esbuild wraps a plugin throw; the original code (e.g. DEPENDENCY_NOT_ALLOWED) stays in errors[0].detail.
      const detail = (error as { errors?: { detail?: unknown }[] } | null)?.errors?.[0]?.detail;
      return fail(errorCode(detail ?? error));
    });
    compiled[kind as keyof typeof entries] = result.outputFiles[0].text;
  }
  return compiled as Record<keyof typeof entries, string>;
}

function approvedConnectionString(): string {
  check(process.execArgv.includes("--use-system-ca"), "SYSTEM_CA_FLAG_REQUIRED");
  // Read only this value; never load the file into process.env or print its contents.
  const value = parse(readFileSync(path.join(root, "../platform/.env"))).DATABASE_URL;
  check(typeof value === "string" && value.length > 0, "DATABASE_URL_MISSING");
  const url = new URL(value);
  check(["postgres:", "postgresql:"].includes(url.protocol), "DATABASE_PROTOCOL_REJECTED");
  check(/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/i.test(url.hostname), "DATABASE_HOST_REJECTED");
  check(!url.port || url.port === "5432", "DATABASE_PORT_REJECTED");
  check(url.pathname.length > 1 && !!url.username && !!url.password, "DATABASE_URL_INCOMPLETE");
  // Remove query overrides (including alternate host and weaker TLS modes).
  url.search = "";
  url.hash = "";
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

type DemoContext = {
  tenantId: string; code: string; fiscalYearStartMonth: number;
  userId: string; permission: "user"; crossTenant: false;
};
const ids = {
  tenant: randomUUID(), otherTenant: randomUUID(), company: randomUUID(),
  deal: randomUUID(), otherDeal: randomUUID(), meeting: randomUUID(),
  latestMeeting: randomUUID(), otherMeeting: randomUUID(),
};
const dealIds = [ids.deal, ids.otherDeal];
const tenantIds = [ids.tenant, ids.otherTenant];
const meetingIds = [ids.meeting, ids.latestMeeting, ids.otherMeeting];
const runTag = `bant-verification-${randomUUID()}`;
function contextFor(tenantId: string): DemoContext {
  return { tenantId, code: runTag, fiscalYearStartMonth: 1,
    userId: "verification-only", permission: "user", crossTenant: false };
}

async function assertFixturesAbsent(client: PrismaClient) {
  // Exact fresh UUIDs only. No table-wide counts or existing records are inspected.
  const counts = await Promise.all([
    client.tenant.count({ where: { id: { in: tenantIds } } }),
    client.company.count({ where: { id: ids.company } }),
    client.deal.count({ where: { id: { in: dealIds } } }),
    client.meeting.count({ where: { id: { in: meetingIds } } }),
    client.aiLog.count({ where: { tenantId: { in: tenantIds }, dealId: { in: dealIds } } }),
  ]);
  check(counts.every(count => count === 0), "FIXTURE_ROWS_REMAIN");
}

async function main() {
  const compiled = await bundleSources();
  if (process.argv.includes("--check-only")) {
    report("SOURCE_BUNDLES_OK_NO_DATABASE_CONNECTION");
    return;
  }
  const connectionString = approvedConnectionString();
  const generated = localRequire(path.join(root, ".verification/generated/client/index.js")) as {
    PrismaClient: typeof PrismaClient;
  };
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 5_000, statement_timeout: 30_000 });
  let poolFailure: string | undefined;
  pool.on("error", error => { poolFailure = errorCode(error); });
  const client = new generated.PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  const dependencies = {
    generated, prisma: undefined as Prisma.TransactionClient | undefined,
    context: contextFor(ids.tenant) as DemoContext | undefined,
    aiCalls: 0, forbiddenCalls: 0, vmErrors: 0,
    generate: async () => { dependencies.aiCalls++; return null; },
    forbidden: () => { dependencies.forbiddenCalls++; return fail("EXTERNAL_CALL_FORBIDDEN"); },
  };
  function load<T>(kind: keyof typeof entries): T {
    const loaded = { exports: {} };
    vm.runInNewContext(compiled[kind], {
      module: loaded, exports: loaded.exports, dependencies,
      // db.ts reuses these caches; its normal tenant extension remains unchanged.
      // summarize-bant.ts は入力の大きさを Buffer.byteLength で測る（vertex.ts の入力上限と同じ測り方）。
      prisma: client, pool, Date, TextDecoder, Buffer, Response, Request,
      process: { env: { NODE_ENV: "test", TENANT_STRICT: "1", DATABASE_URL: "verification-cache-only" } },
      console: {
        log: () => {}, info: () => {}, debug: () => {},
        warn: () => { dependencies.vmErrors++; }, error: () => { dependencies.vmErrors++; },
      },
      require: (name: string) => {
        if (!externals.has(name)) fail("RUNTIME_DEPENDENCY_NOT_ALLOWED");
        return localRequire(name);
      },
      fetch: dependencies.forbidden,
    });
    return loaded.exports as T;
  }

  const rollback = Object.assign(new Error("EXPECTED_ROLLBACK"), { code: "EXPECTED_ROLLBACK" });
  let rolledBack = false;
  let failure: unknown;
  try {
    await assertFixturesAbsent(client);
    const { prisma: scoped } = load<{ prisma: PrismaClient }>("db");
    try {
      await scoped.$transaction(async tx => {
        dependencies.prisma = tx;
        await tx.tenant.create({ data: { id: ids.tenant, code: runTag, name: runTag, shortName: "BANT検証" } });
        await tx.tenant.create({ data: { id: ids.otherTenant, code: `${runTag}-other`, name: runTag, shortName: "境界検証" } });
        await tx.company.create({ data: { id: ids.company, name: runTag, note: runTag, createdByTenantId: ids.tenant } });
        const staleBant = { budget: "未確定: 予算", authority: "未確認: 決裁者", need: "未確定: 課題", timeline: "未確認: 時期", verificationMarker: runTag };
        const created = await tx.deal.create({ data: { id: ids.deal, companyId: ids.company, title: runTag, bant: staleBant } });
        check(created.tenantId === ids.tenant, "DEAL_TENANT_NOT_INJECTED");
        const transcript = "顧客: 予算は300万円です。最終決裁は代表取締役です。採用が課題です。9月15日に判断します。";
        await tx.meeting.create({ data: {
          id: ids.meeting, dealId: ids.deal, title: "根拠ありのデモ商談",
          meetingDate: new Date("2026-09-20T01:00:00Z"), transcript,
          minutes: "デモ議事録", bantBudget: "300万円", bantAuthority: "代表取締役",
          bantNeed: "採用", bantTimeline: "9月15日", sourceType: "manual_text",
        } });
        await tx.meeting.create({ data: {
          id: ids.latestMeeting, dealId: ids.deal, meetingDate: new Date("2026-09-21T01:00:00Z"),
          bantBudget: "未確認: 最新商談では言及なし", sourceType: "manual_text",
        } });
        dependencies.context = contextFor(ids.otherTenant);
        await tx.deal.create({ data: { id: ids.otherDeal, companyId: ids.company, title: `${runTag}-other` } });
        await tx.meeting.create({ data: { id: ids.otherMeeting, dealId: ids.otherDeal, sourceType: "manual_text" } });
        dependencies.context = contextFor(ids.tenant);
        report("DEMO_TRANSACTION_READY");

        const route = load<typeof import("../src/app/api/deals/[id]/route.js")>("route");
        const aggregate = load<typeof import("../src/lib/ai/summarize-bant.js")>("aggregate");
        const cards = load<typeof import("../src/components/deals/bant-summary-utils.js")>("cards");
        const routeContext = (id = ids.deal) => ({ params: Promise.resolve({ id }) });
        const get = (id = ids.deal) => route.GET(new Request("http://verification.invalid"), routeContext(id));
        const patch = (bant: Record<string, string>) => route.PATCH(new Request("http://verification.invalid", {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bant }),
        }), routeContext());
        const getJson = async () => {
          const response = await get();
          check(response.status === 200, "GET_FAILED");
          return (await response.json()).deal;
        };
        let projected = await getJson();
        for (const [key, value] of Object.entries({ budget: "300万円", authority: "代表取締役", need: "採用", timeline: "9月15日" })) {
          const card = cards.resolveBantCardView(projected.bant, key as "budget", projected.meetings);
          check(card.value === value && card.status === "estimated", "GET_CARD_VALUE_MISMATCH");
          check(card.source?.href === `#meeting-${ids.meeting}`, "GET_CARD_SOURCE_MISMATCH");
          check(!!card.source?.quote && transcript.includes(card.source.quote), "GET_QUOTE_NOT_VERBATIM");
        }
        const untouched = await tx.deal.findUniqueOrThrow({ where: { id: ids.deal }, select: { bant: true } });
        check(JSON.stringify(untouched.bant) === JSON.stringify(created.bant), "GET_WROTE_BANT");
        check(dependencies.aiCalls === 0, "GET_CALLED_AI");
        report("ACTUAL_GET_AND_CARD_RESOLVER_OK");

        check((await patch({ need: "手動で確認した採用課題" })).status === 200, "PATCH_FAILED");
        projected = await getJson();
        check(projected.bant.need === "手動で確認した採用課題", "PATCH_VALUE_MISMATCH");
        check(projected.bant.manualFields.need === true && !projected.bant.manualFields.budget, "PATCH_MANUAL_SCOPE_MISMATCH");
        check(projected.bant.items.budget.source_meeting_id === ids.meeting, "PATCH_LOST_OTHER_SOURCE");
        check(await tx.aiLog.count({ where: { dealId: ids.deal, step: "bant_user_edit" } }) === 1, "PATCH_LOG_MISSING");
        check(dependencies.aiCalls === 0, "PATCH_CALLED_AI");
        report("ACTUAL_PATCH_AND_REFETCH_OK");

        const first = await aggregate.summarizeDealBant(ids.deal, { debounce: true, trigger: "development-verification" });
        check(first.bant.budget === "300万円" && first.bant.need === "手動で確認した採用課題", "AGGREGATION_VALUES_MISMATCH");
        check(first.bant.verificationMarker === runTag, "AGGREGATION_METADATA_LOST");
        check(first.fallback && dependencies.aiCalls === 1, "AGGREGATION_STUB_MISMATCH");
        const repeated = await aggregate.summarizeDealBant(ids.deal, { debounce: true });
        check(repeated.skipped === true && dependencies.aiCalls === 1, "DUPLICATE_NOT_SKIPPED");
        await tx.meeting.update({ where: { id: ids.meeting }, data: { bantBudget: "250万円", transcript: transcript.replace("300万円", "250万円") } });
        const changed = await aggregate.summarizeDealBant(ids.deal, { debounce: true });
        check(!changed.skipped && changed.bant.budget === "250万円" && dependencies.aiCalls === 2, "CHANGED_INPUT_NOT_REAGGREGATED");
        check(changed.bant.need === "手動で確認した採用課題", "AGGREGATION_OVERWROTE_MANUAL");
        check(await tx.aiLog.count({ where: { dealId: ids.deal, step: "bant_summary" } }) === 2, "SUMMARY_LOG_COUNT_MISMATCH");
        report("AGGREGATION_DEBOUNCE_AND_CHANGED_INPUT_OK");

        check((await patch({ budget: "" })).status === 200, "CLEAR_PATCH_FAILED");
        const cleared = await aggregate.summarizeDealBant(ids.deal, { debounce: true });
        check(cleared.bant.budget === "" && cleared.bant.items.budget.value === "", "MANUAL_CLEAR_OVERWRITTEN");
        check(cleared.bant.aiSuggestion?.budget?.value === "250万円", "MANUAL_CLEAR_SUGGESTION_MISSING");
        projected = await getJson();
        const blankCard = cards.resolveBantCardView(projected.bant, "budget", projected.meetings);
        check(blankCard.value === "" && blankCard.isManual, "MANUAL_CLEAR_CARD_MISMATCH");
        report("MANUAL_EMPTY_VALUE_PROTECTED");

        check((await get(ids.otherDeal)).status === 404, "OTHER_TENANT_GET_VISIBLE");
        check(await tx.meeting.findUnique({ where: { id: ids.otherMeeting } }) === null, "OTHER_TENANT_MEETING_VISIBLE");
        const blocked = await tx.deal.updateMany({ where: { id: ids.otherDeal }, data: { title: "forbidden-write" } });
        check(blocked.count === 0, "OTHER_TENANT_WRITE_ALLOWED");
        dependencies.context = contextFor(ids.otherTenant);
        const other = await tx.deal.findUniqueOrThrow({ where: { id: ids.otherDeal }, select: { title: true, bant: true } });
        check(other.title === `${runTag}-other` && other.bant === null, "OTHER_TENANT_CHANGED");
        dependencies.context = contextFor(ids.tenant);
        check(dependencies.forbiddenCalls === 0 && dependencies.vmErrors === 0, "UNEXPECTED_EXTERNAL_PATH");
        check(!poolFailure, "POOL_ASYNC_FAILURE");
        report("REAL_TENANT_EXTENSION_BOUNDARY_OK");
        throw rollback;
      }, { maxWait: 15_000, timeout: 120_000 });
      fail("TRANSACTION_UNEXPECTEDLY_COMMITTED");
    } catch (error) {
      if (error === rollback) rolledBack = true;
      else failure = error;
    } finally {
      dependencies.prisma = undefined;
      dependencies.context = undefined;
      await assertFixturesAbsent(client);
      report("ROLLBACK_FIXTURE_IDS_ABSENT");
    }
    if (failure) throw failure;
    check(rolledBack, "EXPECTED_ROLLBACK_NOT_OBSERVED");
    check(!poolFailure, "POOL_ASYNC_FAILURE");
    report(`PASS_ASSERTIONS_${assertions}_AI_EXTERNAL_CALLS_0`);
  } finally {
    try { await client.$disconnect(); } finally { await pool.end(); }
  }
}

main().catch(error => {
  process.stderr.write(`FAIL_${errorCode(error)}\n`);
  process.exitCode = 1;
});
