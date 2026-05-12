/**
 * Notion DB プロパティ実調査（read-only）
 *
 * 目的:
 *   - 「企画内容」プロパティの型・全選択肢・サンプルデータ
 *   - 「ご提案企画書」プロパティの型・サンプルデータ
 *   - 映像プラン関連の周辺プロパティ
 *
 * 使い方:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx --env-file=.env scripts/investigate-notion-plan-and-proposal.ts
 *
 * NOTE: APIキーは絶対にログに出さない
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
    throw new Error(`Notion ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

// 値抽出ヘルパ
function shortPropValue(prop: any): string {
  if (!prop) return "(null)";
  switch (prop.type) {
    case "title": return (prop.title || []).map((t: any) => t.plain_text).join("");
    case "rich_text": return (prop.rich_text || []).map((t: any) => t.plain_text).join("");
    case "select": return prop.select?.name ?? "(empty)";
    case "multi_select": return (prop.multi_select || []).map((s: any) => s.name).join(" | ") || "(empty)";
    case "status": return prop.status?.name ?? "(empty)";
    case "url": return prop.url ?? "(empty)";
    case "files": {
      const files = prop.files || [];
      return files.map((f: any) => {
        const url = f.type === "external" ? f.external?.url : f.file?.url;
        return `[${f.name ?? "(noname)"}](${(url ?? "").slice(0, 80)})`;
      }).join(" | ") || "(empty)";
    }
    case "checkbox": return String(prop.checkbox);
    case "number": return String(prop.number ?? "(empty)");
    case "date": return prop.date?.start ?? "(empty)";
    case "people": return (prop.people || []).map((p: any) => p.name ?? p.id).join(", ");
    case "relation": return (prop.relation || []).map((r: any) => r.id).join(", ");
    case "formula": return JSON.stringify(prop.formula).slice(0, 80);
    case "rollup": return JSON.stringify(prop.rollup).slice(0, 80);
    default: return `(${prop.type})`;
  }
}

async function main() {
  console.log("=== Notion data_source schema (focused) ===\n");

  const schema = await notionFetch(`/v1/data_sources/${DS_ID}`);
  const props = schema.properties || {};

  // -------- 1) 企画内容 / 提案 関連プロパティを抽出 --------
  console.log("--- 関連プロパティ全件 ---");
  const TARGET_KEYWORDS = /企画|提案|プラン|ご提案|映像|動画|サービス|商材|オプション/i;
  const allNames = Object.keys(props).sort((a, b) => a.localeCompare(b, "ja"));
  for (const name of allNames) {
    if (TARGET_KEYWORDS.test(name)) {
      const def = props[name];
      console.log(`  [${def.type.padEnd(14)}] ${name}`);
      // select/multi_select の場合は選択肢全件を表示
      if (def.type === "select") {
        const opts = def.select?.options || [];
        opts.forEach((o: any, i: number) => console.log(`        ${i + 1}. ${o.name}${o.color ? `  (color: ${o.color})` : ""}`));
        console.log(`        (計 ${opts.length} 選択肢)`);
      }
      if (def.type === "multi_select") {
        const opts = def.multi_select?.options || [];
        opts.forEach((o: any, i: number) => console.log(`        ${i + 1}. ${o.name}${o.color ? `  (color: ${o.color})` : ""}`));
        console.log(`        (計 ${opts.length} 選択肢)`);
      }
      if (def.type === "status") {
        const opts = def.status?.options || [];
        opts.forEach((o: any, i: number) => console.log(`        ${i + 1}. ${o.name}${o.color ? `  (color: ${o.color})` : ""}`));
        console.log(`        (計 ${opts.length} 選択肢)`);
      }
    }
  }

  // -------- 2) 「企画内容」と「ご提案企画書」を厳密一致で再表示 --------
  console.log("\n--- 「企画内容」「ご提案企画書」厳密一致 ---");
  const focus = ["企画内容", "ご提案企画書"];
  for (const name of focus) {
    const def = props[name];
    if (!def) {
      console.log(`  ${name}: NOT FOUND`);
      continue;
    }
    console.log(`  ${name}: type=${def.type}`);
    if (def.type === "select" || def.type === "multi_select" || def.type === "status") {
      const opts = def[def.type]?.options || [];
      console.log(`    options(${opts.length}):`);
      opts.forEach((o: any, i: number) => console.log(`      ${i + 1}. "${o.name}"  color=${o.color ?? "-"}`));
    }
  }

  // -------- 3) 全ページ取得 --------
  console.log("\n=== 全ページサンプリング ===");
  const all: any[] = [];
  let cursor: string | undefined;
  let safety = 0;
  do {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data: any = await notionFetch(`/v1/data_sources/${DS_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
    safety += 1;
    if (safety > 200) break;
  } while (cursor);
  console.log(`総ページ数: ${all.length}`);

  // -------- 4) 「企画内容」プロパティの実値分布 --------
  console.log("\n--- 「企画内容」実データ分布 ---");
  const planValueCount = new Map<string, number>();
  let kikakuFilled = 0;
  let kikakuEmpty = 0;
  for (const p of all) {
    const prop = p.properties?.["企画内容"];
    if (!prop) { kikakuEmpty++; continue; }
    const val = shortPropValue(prop);
    if (val === "(empty)" || val === "(null)") {
      kikakuEmpty++;
    } else {
      kikakuFilled++;
      // multi_select 想定では "A | B | C" の形で来るのでそのまま集計し、
      // さらに分解しても集計する
      planValueCount.set(val, (planValueCount.get(val) || 0) + 1);
    }
  }
  console.log(`  filled=${kikakuFilled}  empty=${kikakuEmpty}`);
  console.log(`  ユニーク値数: ${planValueCount.size}`);
  console.log(`  Top 30 (件数降順):`);
  [...planValueCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .forEach(([v, c], i) => console.log(`    ${String(i + 1).padStart(2)}. (${String(c).padStart(3)}件) ${v}`));

  // multi_select 分解版（"|" 区切りで個別カウント）
  const flatCount = new Map<string, number>();
  for (const [v, c] of planValueCount) {
    for (const part of v.split("|").map(s => s.trim()).filter(Boolean)) {
      flatCount.set(part, (flatCount.get(part) || 0) + c);
    }
  }
  console.log(`\n  Flat unique（"|"分解後）: ${flatCount.size}`);
  console.log(`  Flat Top 30:`);
  [...flatCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .forEach(([v, c], i) => console.log(`    ${String(i + 1).padStart(2)}. (${String(c).padStart(3)}件) ${v}`));

  // -------- 5) 「ご提案企画書」プロパティ実データ --------
  console.log("\n--- 「ご提案企画書」実データ ---");
  let goteianFilled = 0;
  let goteianEmpty = 0;
  const goteianSamples: Array<{ id: string; companyName: string; value: string }> = [];
  for (const p of all) {
    const prop = p.properties?.["ご提案企画書"];
    const val = shortPropValue(prop);
    if (val === "(empty)" || val === "(null)") {
      goteianEmpty++;
    } else {
      goteianFilled++;
      // 会社名らしきものを探す
      let companyName = "(no-name)";
      for (const propName of ["企業名", "顧客名", "会社名", "Company"]) {
        if (p.properties?.[propName]) {
          const n = shortPropValue(p.properties[propName]);
          if (n && n !== "(empty)" && n !== "(null)") {
            companyName = n;
            break;
          }
        }
      }
      if (companyName === "(no-name)") {
        // title プロパティを探す
        for (const [pn, pd] of Object.entries(p.properties || {})) {
          if ((pd as any)?.type === "title") {
            companyName = shortPropValue(pd) || "(no-name)";
            break;
          }
        }
      }
      if (goteianSamples.length < 10) {
        goteianSamples.push({ id: p.id, companyName, value: val });
      }
    }
  }
  console.log(`  filled=${goteianFilled}  empty=${goteianEmpty}`);
  console.log(`  Samples（最大10件）:`);
  for (const s of goteianSamples) {
    console.log(`    [${s.companyName}]  ${s.value}`);
  }

  // -------- 6) 「企画内容」と「ご提案企画書」の組み合わせサンプル --------
  console.log("\n--- 「企画内容」&「ご提案企画書」両方アリのサンプル5件 ---");
  let combo = 0;
  for (const p of all) {
    if (combo >= 5) break;
    const k = p.properties?.["企画内容"];
    const g = p.properties?.["ご提案企画書"];
    const kv = shortPropValue(k);
    const gv = shortPropValue(g);
    if (kv === "(empty)" || kv === "(null)") continue;
    if (gv === "(empty)" || gv === "(null)") continue;
    combo++;
    let companyName = "(no-name)";
    for (const [pn, pd] of Object.entries(p.properties || {})) {
      if ((pd as any)?.type === "title") {
        companyName = shortPropValue(pd) || "(no-name)";
        break;
      }
    }
    console.log(`  ${combo}. [${companyName}]`);
    console.log(`     企画内容    : ${kv}`);
    console.log(`     ご提案企画書: ${gv}`);
  }

  console.log("\n=== Done (read-only) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
