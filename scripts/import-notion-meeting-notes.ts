/**
 * Notion ヨミ表DB → deals.bant.meetingNotes 取込スクリプト
 *
 * 方針:
 * - 各 Notion ページから Block を再帰取得し、全テキストを markdown 風に連結（FULL_PAGE_MODE）。
 * - 該当 Deal は `deals.bant.notionPageId` で一意紐付け。
 * - 保存先: deals.bant の以下キー（スキーマ変更なし）
 *     - meetingNotes        : 議事録本文（plain markdown 風）
 *     - meetingNotesSection : "full_page"
 *     - meetingNotesSource  : "notion"
 *     - meetingNotesUpdatedAt: ISO 文字列（本投入時刻）
 *     - meetingNotesNotionLastEditedAt: Notion ページの last_edited_time
 *
 * 安全策:
 * - DATABASE_URL に "salesagent_luma" / "neondb" を含まない場合は即 abort
 * - NOTION_API_KEY 未設定なら即 abort
 * - 既存 bant.meetingNotes が入っていて、Notion 側に内容が無い場合は上書きしない
 * - レート制限考慮: 各ページごとに sleep（< 3 req/sec）
 * - 個人情報を含むため、議事録本文をログに長く出力しない
 *
 * 堅牢化（504/502/429/ハング対策）:
 * - undici Agent で headersTimeout / bodyTimeout を強制（pooled keep-alive socket のハングを socket レベルで切る）
 * - keep-alive を短命化し、stuck socket の再利用を避ける
 * - 5xx / ネットワークエラー / タイムアウト時は指数バックオフで最大5回リトライ
 * - リトライ尽きたページは warn を出してスキップし、処理全体は止めない
 *
 * 使い方:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   # ドライラン（DB書き込みなし、件数とサンプル3件出力）
 *   npx tsx --env-file=.env scripts/import-notion-meeting-notes.ts
 *   # 本投入（ローカルDB）
 *   npx tsx --env-file=.env scripts/import-notion-meeting-notes.ts --apply
 *   # 本投入（Neon 本番。DATABASE_URL を上書きして .env から Notion キーを使う）
 *   PROD=$(grep ^DATABASE_URL= .env.production.local | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   DATABASE_URL="$PROD" RESUME=1 npx tsx --env-file=.env scripts/import-notion-meeting-notes.ts --apply
 */

import { Agent, setGlobalDispatcher } from "undici";
import { prisma } from "../src/lib/db";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DB_ID = process.env.NOTION_LUMA_YOMI_DB_ID;
const NOTION_VERSION = "2025-09-03";
const TARGET_HEADING = "★初回商談ヒアリングシート";
// レート制限考慮の sleep（env で調整可能）。Notion は平均 ~3 req/sec まで許容。
// 429 はリトライで吸収するため、デフォルトをやや短めにして全体時間を抑える。
const RATE_LIMIT_SLEEP_MS = process.env.PAGE_SLEEP_MS ? Number(process.env.PAGE_SLEEP_MS) : 350;
const CHILD_BLOCK_SLEEP_MS = process.env.CHILD_SLEEP_MS ? Number(process.env.CHILD_SLEEP_MS) : 150;
// 全Block取込モード（深度3まで再帰）
const MAX_BLOCK_DEPTH = 3;
const FULL_PAGE_MODE = true;

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

// 5xx/ネットワークエラー用の指数バックオフ。max5回（1s→2s→4s→8s→16s）。
const MAX_TRANSIENT_RETRIES = 5;
// ソケットレベルのタイムアウト（undici が直接強制する。AbortController と違い pooled socket でも確実に切れる）
const HEADERS_TIMEOUT_MS = 30000;
const BODY_TIMEOUT_MS = 30000;

// undici グローバル dispatcher: ヘッダ/ボディのタイムアウトを socket レベルで強制し、
// keep-alive socket を短命化して stuck socket の再利用を防ぐ。
setGlobalDispatcher(
  new Agent({
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    keepAliveTimeout: 5000,
    keepAliveMaxTimeout: 10000,
    connect: { timeout: 15000 },
  }),
);

function safeCheck() {
  const url = process.env.DATABASE_URL ?? "";
  // 許可: ローカル salesagent_luma または Neon neondb
  if (!url.includes("salesagent_luma") && !url.includes("neondb")) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma or neondb");
    process.exit(1);
  }
  if (!NOTION_API_KEY) {
    console.error("ABORT: NOTION_API_KEY not set");
    process.exit(1);
  }
  if (!NOTION_DB_ID) {
    console.error("ABORT: NOTION_LUMA_YOMI_DB_ID not set");
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 1リクエストの実時間ハードリミット。これを超えたら（ソケットが固まって
// undici/AbortController が応答しなくても）Promise.race で必ず reject させ、
// リトライへ移行する。固まったソケットは leak するが一回限りのバックフィルなので許容。
const HARD_REQUEST_TIMEOUT_MS = 25000;

class HardTimeoutError extends Error {
  constructor() {
    super(`hard-timeout >${HARD_REQUEST_TIMEOUT_MS}ms`);
    this.name = "HardTimeoutError";
  }
}

/** op を HARD_REQUEST_TIMEOUT_MS でタイムボックス。超過時は ac.abort() して reject。 */
function withHardTimeout<T>(ac: AbortController, op: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        ac.abort();
      } catch {
        // ignore
      }
      reject(new HardTimeoutError());
    }, HARD_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([op().finally(() => clearTimeout(timer)), timeout]);
}

function isTransient(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string };
  const name = err?.name ?? "";
  const code = err?.code ?? "";
  const msg = err?.message ?? "";
  return (
    name === "AbortError" ||
    name === "HardTimeoutError" ||
    /Timeout|TimeoutError/i.test(name) ||
    /UND_ERR_(HEADERS_TIMEOUT|BODY_TIMEOUT|CONNECT_TIMEOUT|SOCKET)/i.test(code) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i.test(code) ||
    /timeout|terminated|socket|network|fetch failed/i.test(msg)
  );
}

async function notionFetch(path: string, init?: RequestInit): Promise<unknown> {
  let rateRetries = 0;
  let transientRetries = 0;
  while (true) {
    let res: Response;
    let text: string;
    const ac = new AbortController();
    try {
      // fetch + 本文読み出しを 1 つの hard-timeout 配下に置く。
      // ソケットが固まっても HARD_REQUEST_TIMEOUT_MS で必ず reject される。
      const out = await withHardTimeout(ac, async () => {
        const r = await fetch(`https://api.notion.com${path}`, {
          ...init,
          signal: ac.signal,
          headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
            ...(init?.headers || {}),
          },
        });
        const t = await r.text();
        return { r, t };
      });
      res = out.r;
      text = out.t;
    } catch (e) {
      // ネットワークエラー / タイムアウト / 接続断 → 指数バックオフでリトライ
      if (isTransient(e) && transientRetries < MAX_TRANSIENT_RETRIES) {
        const wait = 1000 * Math.pow(2, transientRetries);
        const label = ((e as Error).name || "") + " " + ((e as { code?: string }).code || "") + " " + ((e as Error).message?.slice(0, 60) ?? "");
        console.warn(
          `  [network] ${label.trim()}, retry ${transientRetries + 1}/${MAX_TRANSIENT_RETRIES} in ${wait}ms`,
        );
        await sleep(wait);
        transientRetries++;
        continue;
      }
      throw new Error(`Notion network error ${path}: ${(e as Error).message?.slice(0, 200)}`);
    }

    // 429: レート制限（既存ロジック維持）
    if (res.status === 429 && rateRetries < 7) {
      const wait = 2000 * Math.pow(2, rateRetries);
      console.warn(`  [rate-limit] 429, retry in ${wait}ms`);
      await sleep(wait);
      rateRetries++;
      continue;
    }

    // 502/503/504 等の 5xx ゲートウェイ系 → 指数バックオフでリトライ
    if (res.status >= 500 && res.status < 600 && transientRetries < MAX_TRANSIENT_RETRIES) {
      const wait = 1000 * Math.pow(2, transientRetries);
      console.warn(
        `  [gateway] ${res.status}, retry ${transientRetries + 1}/${MAX_TRANSIENT_RETRIES} in ${wait}ms`,
      );
      await sleep(wait);
      transientRetries++;
      continue;
    }

    if (!res.ok) {
      throw new Error(`Notion ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

function richTextToPlain(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt
    .map((t) => (t && typeof t === "object" && "plain_text" in t ? String((t as { plain_text: unknown }).plain_text ?? "") : ""))
    .join("");
}

function blockText(b: NotionBlock): string {
  const t = b.type;
  const holder = (b as Record<string, unknown>)[t];
  if (!holder || typeof holder !== "object") return "";
  const h = holder as Record<string, unknown>;
  if (Array.isArray(h.rich_text)) return richTextToPlain(h.rich_text);
  if (typeof h.text === "string") return h.text;
  return "";
}

// Block を Markdown 風プレフィックス付きで整形
function formatBlockLine(b: NotionBlock, depth: number): string | null {
  const text = blockText(b);
  if (!text) {
    return null;
  }
  const indent = "  ".repeat(Math.min(depth, MAX_BLOCK_DEPTH));
  switch (b.type) {
    case "heading_1":
      return `${indent}# ${text}`;
    case "heading_2":
      return `${indent}## ${text}`;
    case "heading_3":
      return `${indent}### ${text}`;
    case "bulleted_list_item":
      return `${indent}- ${text}`;
    case "numbered_list_item":
      return `${indent}1. ${text}`;
    case "to_do":
      return `${indent}- [ ] ${text}`;
    case "quote":
      return `${indent}> ${text}`;
    case "callout":
      return `${indent}> ${text}`;
    case "code":
      return `${indent}    ${text}`;
    case "paragraph":
    default:
      return `${indent}${text}`;
  }
}

interface FlatBlock {
  type: string;
  text: string;
  depth: number;
  formatted: string;
}

async function listAllBlocks(blockId: string, depth = 0): Promise<FlatBlock[]> {
  const out: FlatBlock[] = [];
  if (depth > MAX_BLOCK_DEPTH) return out;
  let cursor: string | undefined;
  let safety = 0;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const j = (await notionFetch(`/v1/blocks/${blockId}/children${qs}`)) as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string;
    };
    for (const b of j.results || []) {
      const formatted = formatBlockLine(b, depth);
      out.push({
        type: b.type,
        text: blockText(b),
        depth,
        formatted: formatted ?? "",
      });
      if (b.has_children) {
        await sleep(CHILD_BLOCK_SLEEP_MS);
        const child = await listAllBlocks(b.id, depth + 1);
        out.push(...child);
      }
    }
    cursor = j.has_more ? j.next_cursor : undefined;
    safety++;
    if (safety > 30) break;
  } while (cursor);
  return out;
}

/** ページBlockから「★初回商談ヒアリングシート」セクションを抽出（heading検索モード） */
function extractTargetSection(blocks: FlatBlock[]): {
  found: boolean;
  body: string;
  lineCount: number;
} {
  let inTarget = false;
  let targetDepth = 0;
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading_1") {
      if (b.text.trim() === TARGET_HEADING) {
        inTarget = true;
        targetDepth = b.depth;
        continue;
      }
      if (inTarget && b.depth <= targetDepth) {
        inTarget = false;
      }
    }
    if (inTarget) {
      if (b.formatted) lines.push(b.formatted);
    }
  }
  const body = lines.join("\n").trim();
  return { found: lines.length > 0, body, lineCount: lines.length };
}

/** ページBlockの全テキストをmarkdown風に連結（全文取込モード） */
function extractAllText(blocks: FlatBlock[]): {
  found: boolean;
  body: string;
  lineCount: number;
} {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.formatted) lines.push(b.formatted);
  }
  const body = lines.join("\n").trim();
  return { found: body.length > 0, body, lineCount: lines.length };
}

interface QueryPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}

async function queryAllPages(): Promise<QueryPage[]> {
  const all: QueryPage[] = [];
  let cursor: string | undefined;
  let batch = 0;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const j = (await notionFetch(`/v1/data_sources/${NOTION_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    })) as { results?: QueryPage[]; has_more?: boolean; next_cursor?: string };
    for (const p of j.results || []) all.push(p);
    cursor = j.has_more ? j.next_cursor : undefined;
    batch++;
    if (batch % 5 === 0) console.log(`  [query] fetched ${all.length} pages so far...`);
    await sleep(200);
  } while (cursor);
  return all;
}

function pickTitle(properties: Record<string, unknown> | undefined): string {
  if (!properties) return "(no-title)";
  for (const pd of Object.values(properties)) {
    if (pd && typeof pd === "object" && (pd as { type?: string }).type === "title") {
      const arr = (pd as { title?: unknown }).title;
      return richTextToPlain(arr) || "(no-title)";
    }
  }
  return "(no-title)";
}

async function main() {
  safeCheck();
  console.log(`\n=== Notion 議事録取込 ${DRY_RUN ? "[DRY RUN]" : "[APPLY]"} ===\n`);
  console.log(`  target heading: ${TARGET_HEADING}`);
  console.log(`  database: ${process.env.DATABASE_URL?.match(/\/([^/?]+)\?/)?.[1] ?? (process.env.DATABASE_URL?.includes("neondb") ? "neondb" : "?")}`);
  console.log(`  notion db: ${NOTION_DB_ID}`);

  // 1) DBの全 deals を notionPageId 付きで取得
  const deals = await prisma.deal.findMany({
    select: { id: true, title: true, bant: true, company: { select: { name: true } } },
  });
  console.log(`  deals in DB: ${deals.length}`);

  const byPageId = new Map<
    string,
    { dealId: string; title: string; companyName: string; existingNotes: string | null }
  >();
  for (const d of deals) {
    const b =
      d.bant && typeof d.bant === "object" && !Array.isArray(d.bant)
        ? (d.bant as Record<string, unknown>)
        : null;
    const pageId = typeof b?.notionPageId === "string" ? b.notionPageId : null;
    if (!pageId) continue;
    const existingNotes =
      typeof b?.meetingNotes === "string" && (b.meetingNotes as string).length > 0
        ? (b.meetingNotes as string)
        : null;
    byPageId.set(pageId, {
      dealId: d.id,
      title: d.title || "(no-title)",
      companyName: d.company.name,
      existingNotes,
    });
  }
  console.log(`  deals with notionPageId: ${byPageId.size}`);

  // 2) Notion から全ページ取得
  console.log(`\n  [phase1] fetching all Notion pages...`);
  const pages = await queryAllPages();
  console.log(`  notion pages: ${pages.length}`);

  // 3) 各ページのBlockを取得して抽出
  console.log(`\n  [phase2] extracting meeting notes...`);
  let processed = 0;
  let extractedCount = 0;
  let notMatchedToDb = 0;
  let extractedTotalChars = 0;
  let willUpdate = 0;
  let willSkipExisting = 0;
  let willSkipNoMatch = 0;
  let willSkipNoTarget = 0;
  let pagesFailed = 0;
  const failedPageIds: string[] = [];
  const samples: { company: string; title: string; chars: number; preview: string }[] = [];
  const updates: {
    dealId: string;
    body: string;
    notionLastEditedAt: string | null;
  }[] = [];

  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
  const resumeMode = process.env.RESUME === "1";
  if (limit !== Infinity) {
    console.log(`  [limit] processing first ${limit} unprocessed pages (LIMIT env var)`);
  }
  if (resumeMode) {
    const existingCount = Array.from(byPageId.values()).filter((v) => v.existingNotes).length;
    console.log(`  [resume] mode ON: ${existingCount} pages already have meetingNotes, will skip without API call`);
  }
  let processedSinceStart = 0;
  for (const p of pages) {
    processed++;

    const mapped = byPageId.get(p.id);
    if (!mapped) {
      notMatchedToDb++;
      willSkipNoMatch++;
      continue;
    }

    if (resumeMode && mapped.existingNotes) {
      willSkipExisting++;
      continue;
    }

    processedSinceStart++;
    if (processedSinceStart > limit) {
      console.log(`  [limit] reached LIMIT=${limit}, stopping`);
      break;
    }
    if (processedSinceStart % 10 === 0) {
      console.log(
        `  [progress] ${processedSinceStart} processed (page ${processed}/${pages.length}), extracted=${extractedCount}, willUpdate=${willUpdate}, failed=${pagesFailed}`,
      );
    }

    let blocks: FlatBlock[];
    try {
      blocks = await listAllBlocks(p.id, 0);
    } catch (e) {
      pagesFailed++;
      failedPageIds.push(p.id);
      console.warn(`  [warn] failed to list blocks for page ${p.id}: ${(e as Error).message?.slice(0, 120)}`);
      await sleep(RATE_LIMIT_SLEEP_MS);
      continue;
    }

    const { found, body, lineCount } = FULL_PAGE_MODE
      ? extractAllText(blocks)
      : extractTargetSection(blocks);
    void lineCount;

    if (!found || body.length === 0) {
      willSkipNoTarget++;
      await sleep(RATE_LIMIT_SLEEP_MS);
      continue;
    }

    extractedCount++;
    extractedTotalChars += body.length;

    if (mapped.existingNotes && mapped.existingNotes === body) {
      willSkipExisting++;
      await sleep(RATE_LIMIT_SLEEP_MS);
      continue;
    }

    willUpdate++;
    updates.push({
      dealId: mapped.dealId,
      body,
      notionLastEditedAt: p.last_edited_time ?? null,
    });

    if (samples.length < 3) {
      samples.push({
        company: mapped.companyName,
        title: mapped.title,
        chars: body.length,
        preview: body.slice(0, 600),
      });
    }

    await sleep(RATE_LIMIT_SLEEP_MS);
  }

  console.log(`\n=== Phase 2 Summary ===`);
  console.log(`  total notion pages         : ${pages.length}`);
  console.log(`  matched to DB deal         : ${pages.length - notMatchedToDb}`);
  console.log(`  not matched to DB          : ${notMatchedToDb}`);
  console.log(`  extracted (content found)  : ${extractedCount}`);
  console.log(`  avg chars (extracted)      : ${extractedCount > 0 ? Math.round(extractedTotalChars / extractedCount) : 0}`);
  console.log(`  will update                : ${willUpdate}`);
  console.log(`  skip (already same/exists) : ${willSkipExisting}`);
  console.log(`  skip (no content)          : ${willSkipNoTarget}`);
  console.log(`  skip (no DB match)         : ${willSkipNoMatch}`);
  console.log(`  pages failed (retry exhausted): ${pagesFailed}`);
  if (failedPageIds.length > 0) {
    console.log(`  failed page ids (first 20) : ${failedPageIds.slice(0, 20).join(", ")}`);
  }

  // 4) サンプル表示
  console.log(`\n=== Sample 3 ===`);
  for (const [i, s] of samples.entries()) {
    console.log(`\n  ----- Sample ${i + 1}: ${s.company} / ${s.title} -----`);
    console.log(`  chars: ${s.chars}`);
    console.log(`  preview (first 600 chars):`);
    console.log(
      s.preview
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }

  // 5) DRY RUN ならここで終了
  if (DRY_RUN) {
    console.log(`\n[DRY RUN] no DB changes. Run with --apply to write.`);
    await prisma.$disconnect();
    return;
  }

  // 6) 本投入
  console.log(`\n[APPLY] writing ${updates.length} updates to DB...`);
  const now = new Date().toISOString();
  let wrote = 0;
  let writeErrors = 0;
  for (const u of updates) {
    try {
      const cur = await prisma.deal.findUnique({
        where: { id: u.dealId },
        select: { bant: true },
      });
      const curBant =
        cur?.bant && typeof cur.bant === "object" && !Array.isArray(cur.bant)
          ? (cur.bant as Record<string, unknown>)
          : {};
      const nextBant: Record<string, unknown> = {
        ...curBant,
        meetingNotes: u.body,
        meetingNotesSection: FULL_PAGE_MODE ? "full_page" : TARGET_HEADING,
        meetingNotesSource: "notion",
        meetingNotesUpdatedAt: now,
        meetingNotesNotionLastEditedAt: u.notionLastEditedAt,
      };
      await prisma.deal.update({
        where: { id: u.dealId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { bant: nextBant as any },
      });
      wrote++;
      if (wrote % 20 === 0) console.log(`  [write] ${wrote}/${updates.length}`);
    } catch (e) {
      writeErrors++;
      console.warn(`  [write-error] dealId=${u.dealId}: ${(e as Error).message}`);
    }
  }
  console.log(`\n[APPLY] done. wrote=${wrote} errors=${writeErrors} pagesFailed=${pagesFailed}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
