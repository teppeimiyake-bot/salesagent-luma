/**
 * Notion「企画内容」multi_select 選択肢の最新確認（read-only）
 * 使い方: npx tsx --env-file=.env scripts/probe-plan-options.ts
 */
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DS_ID = process.env.NOTION_LUMA_YOMI_DB_ID;
if (!NOTION_API_KEY || !DS_ID) {
  console.error("env not set (NOTION_API_KEY / NOTION_LUMA_YOMI_DB_ID)");
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
  if (!res.ok) throw new Error(`Notion ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}
(async () => {
  const schema = await notionFetch(`/v1/data_sources/${DS_ID}`);
  const def = schema.properties?.["企画内容"];
  console.log("企画内容 type:", def?.type);
  const opts = def?.multi_select?.options || def?.select?.options || [];
  console.log("選択肢数:", opts.length);
  opts.forEach((o: any, i: number) => console.log(`${i + 1}. "${o.name}"  color=${o.color}`));
  // 使用回数集計
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
    safety++;
    if (safety > 200) break;
  } while (cursor);
  const flat = new Map<string, number>();
  let filled = 0;
  for (const p of all) {
    const prop = p.properties?.["企画内容"];
    const arr = prop?.multi_select || [];
    if (arr.length) filled++;
    for (const s of arr) flat.set(s.name, (flat.get(s.name) || 0) + 1);
  }
  console.log(`\n総ページ数: ${all.length}, 企画内容 filled: ${filled}`);
  console.log("選択肢別 使用回数:");
  for (const o of opts) console.log(`  ${String(flat.get(o.name) || 0).padStart(4)}  ${o.name}`);
  // マスタに無い値が使われていないかチェック
  const optNames = new Set(opts.map((o: any) => o.name));
  const orphans = [...flat.keys()].filter((k) => !optNames.has(k));
  if (orphans.length) console.log("\n[注意] マスタに無い値:", orphans);
  else console.log("\n(マスタ外の値なし)");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
