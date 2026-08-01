/**
 * リージー企業 → Luma企業 のマッピング表を作る（Phase 5 の移管で使う）
 * ============================================================
 * リージーの顧客をどの Luma 企業に紐付けるか（または新規作成するか）の一覧を
 * docs/merge/companies-map.csv に出力する。人手レビューを前提とした資料。
 *
 * 判定:
 *   MATCH   … 社名が完全一致
 *   MATCH?  … 正規化（法人格・記号・全半角を除去）して一致 → 目視確認が必要
 *   MULTI   … Luma 側に候補が複数 → どれに寄せるか選択が必要
 *   NEW     … Luma に無い → 新規作成
 *
 * 「別会社」として記録済みのペア（company_merge_dismissed）は候補から除外する。
 *
 * 実行: node scripts/build-company-map.mjs
 */
import fs from "node:fs";
import pg from "pg";

const lumaUrl = fs.readFileSync(".env.production.local", "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];
const rgUrl = fs.readFileSync("C:/dev/salesagent-reagey/.env.production", "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];

// 法人格・記号・全半角の揺れを吸収して比較する
const norm = (s) =>
  s.replace(/株式会社|有限会社|合同会社|一般社団法人|弁理士法人|税理士法人|\s|　|・|\(|\)|（|）|＆|&/g, "")
    .toLowerCase()
    .normalize("NFKC");
const csv = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const A = new pg.Client({ connectionString: lumaUrl });
const B = new pg.Client({ connectionString: rgUrl });
await A.connect();
await B.connect();

// Luma 側：生きている企業（統合済み・削除済みは除く）
const luma = (await A.query(`
  select c.id, c.name,
    (select count(*)::int from deals d where d.company_id=c.id and d.deleted_at is null) deals,
    (select count(*)::int from deals d join deal_products dp on dp.deal_id=d.id
       where d.company_id=c.id and dp.yomi_status like '%受注%') won,
    (select count(*)::int from contacts ct where ct.company_id=c.id) contacts
  from companies c
  where c.deleted_at is null and c.merged_into_id is null`)).rows;

// 「別会社」と判定済みのペア（同名判定に引っかかっても候補にしない）
const dismissed = new Set();
for (const r of (await A.query(`select company_id_a a, company_id_b b from company_merge_dismissed`)).rows) {
  dismissed.add(`${r.a}|${r.b}`);
  dismissed.add(`${r.b}|${r.a}`);
}

const byNorm = new Map();
for (const r of luma) {
  const k = norm(r.name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(r);
}

const rg = (await B.query(`
  select c.id, c.name, c.industries,
    (select count(*)::int from deals d where d.company_id=c.id) deals,
    (select count(*)::int from deals d join deal_products dp on dp.deal_id=d.id
       where d.company_id=c.id and dp.yomi_status like '%受注%') won,
    (select count(*)::int from contacts ct where ct.company_id=c.id) contacts
  from companies c where c.deleted_at is null order by c.name`)).rows;

const out = [
  ["判定", "リージー企業名", "リージー_ID", "R_商談", "R_受注", "R_連絡先",
   "Luma企業名", "Luma_ID", "L_商談", "L_受注", "L_連絡先", "要確認事項"].join(","),
];
const tally = { MATCH: 0, "MATCH?": 0, MULTI: 0, NEW: 0 };

for (const r of rg) {
  let cands = byNorm.get(norm(r.name)) ?? [];
  // 候補どうしが「別会社」と記録されている場合は、完全一致するほうだけ残す
  if (cands.length > 1) {
    const exact = cands.filter((c) => c.name === r.name);
    const pairDismissed = cands.some((x, i) => cands.some((y, j) => i < j && dismissed.has(`${x.id}|${y.id}`)));
    if (pairDismissed && exact.length === 1) cands = exact;
  }

  if (cands.length === 0) {
    tally.NEW++;
    out.push(["NEW（新規作成）", csv(r.name), r.id, r.deals, r.won, r.contacts, "", "", "", "", "", ""].join(","));
    continue;
  }
  const multi = cands.length > 1;
  for (const c of cands) {
    const exact = c.name === r.name;
    const verdict = multi ? "MULTI（候補複数・要選択）" : exact ? "MATCH（完全一致）" : "MATCH?（表記ゆれ・要目視）";
    const note = multi
      ? `Luma側に候補${cands.length}件。完全名と受注実績で確認`
      : exact ? "" : `表記ゆれ: 「${r.name}」 vs 「${c.name}」`;
    out.push([verdict, csv(r.name), r.id, r.deals, r.won, r.contacts,
      csv(c.name + (exact ? " ★完全一致" : "")), c.id, c.deals, c.won, c.contacts, csv(note)].join(","));
  }
  tally[multi ? "MULTI" : cands[0].name === r.name ? "MATCH" : "MATCH?"]++;
}

fs.writeFileSync("docs/merge/companies-map.csv", "\uFEFF" + out.join("\n"), "utf8");

console.log(`リージー有効企業: ${rg.length} 社`);
console.log(`  MATCH （完全一致）        : ${tally.MATCH}`);
console.log(`  MATCH?（表記ゆれ・要目視）: ${tally["MATCH?"]}`);
console.log(`  MULTI （候補複数・要選択）: ${tally.MULTI}`);
console.log(`  NEW   （新規作成）        : ${tally.NEW}`);
console.log("\n--- 要目視（表記ゆれ）---");
out.slice(1).filter((l) => l.startsWith("MATCH?")).forEach((l) => {
  const c = l.split(",");
  console.log(`   ${c[1]}  <->  ${c[6]}`);
});
const multiLines = out.slice(1).filter((l) => l.startsWith("MULTI"));
console.log(`--- 候補複数: ${multiLines.length ? "" : "なし"}`);
multiLines.forEach((l) => {
  const c = l.split(",");
  console.log(`   ${c[1]}  ->  ${c[6]}`);
});
console.log(`\ndocs/merge/companies-map.csv を更新（Luma側の生存企業 ${luma.length} 社と突合）`);

await A.end();
await B.end();
