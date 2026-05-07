/**
 * Notion DBスキーマ調査スクリプト (read-only)
 *
 * Notion API 2025-09-03 の data_source エンドポイントを使用。
 * NOTION_LUMA_YOMI_DB_ID の中身は実は data_source ID。
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "..", ".env") });

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DS_ID = process.env.NOTION_LUMA_YOMI_DB_ID;

if (!NOTION_API_KEY || !DS_ID) {
  console.error("env not set");
  process.exit(1);
}

const NOTION_VERSION = "2025-09-03";

async function notionFetch(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.notion.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

type PropMeta = { name: string; type: string };

async function getDataSourceSchema(): Promise<{ title: string; props: PropMeta[]; raw: any }> {
  const data = await notionFetch(`/v1/data_sources/${DS_ID}`);
  const props: PropMeta[] = Object.entries(data.properties || {}).map(
    ([name, def]: [string, any]) => ({ name, type: def.type }),
  );
  const title = (data.title || []).map((t: any) => t.plain_text).join("") || "(no title)";
  return { title, props, raw: data };
}

type Page = { id: string; properties: Record<string, any> };

async function queryAllPages(): Promise<Page[]> {
  const all: Page[] = [];
  let cursor: string | undefined;
  let safety = 0;
  do {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data: any = await notionFetch(`/v1/data_sources/${DS_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const p of data.results) {
      all.push({ id: p.id, properties: p.properties });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
    safety += 1;
    if (safety > 200) break;
  } while (cursor);
  return all;
}

function extractDate(prop: any): string | null {
  if (!prop) return null;
  if (prop.type === "date") return prop.date?.start ?? null;
  return null;
}

async function main() {
  console.log("=== Notion data_source schema ===\n");
  const schema = await getDataSourceSchema();
  console.log(`title: ${schema.title}`);
  console.log(`id: ${DS_ID}`);
  console.log(`prop count: ${schema.props.length}\n`);

  console.log("--- All properties (sorted) ---");
  const sorted = [...schema.props].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  for (const p of sorted) {
    console.log(`  ${p.type.padEnd(14)}  ${p.name}`);
  }

  console.log("\n--- Date-typed properties ---");
  const dateProps = schema.props.filter((p) => p.type === "date");
  for (const p of dateProps) console.log(`  - ${p.name}`);

  console.log("\n--- Property names containing 商談/初回/アポ/meeting/appoint/first ---");
  const cand = schema.props.filter((p) => /商談|初回|アポ|meeting|appoint|first/i.test(p.name));
  for (const p of cand) console.log(`  ${p.type.padEnd(14)}  ${p.name}`);

  const has商談日 = schema.props.some((p) => p.name === "商談日");
  const has初回商談日 = schema.props.some((p) => p.name === "初回商談日");
  console.log(`\n  「商談日」exists: ${has商談日 ? "YES" : "NO"}`);
  console.log(`  「初回商談日」exists: ${has初回商談日 ? "YES" : "NO"}`);

  console.log("\n=== Querying all pages ===");
  const pages = await queryAllPages();
  console.log(`pages: ${pages.length}\n`);

  let filled = 0;
  let empty = 0;
  const samples: Array<{ id: string; 商談日: string | null }> = [];
  for (const p of pages) {
    const d = extractDate(p.properties["商談日"]);
    if (d) filled += 1;
    else empty += 1;
    if (samples.length < 8 && d) samples.push({ id: p.id, 商談日: d });
  }
  console.log(`商談日 filled: ${filled}`);
  console.log(`商談日 empty:  ${empty}`);
  console.log("\nSamples:");
  for (const s of samples) console.log(`  ${s.id}  商談日=${s.商談日}`);

  console.log("\n=== Done (read-only) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
