/**
 * 商談タイトル一括バックフィル
 *
 * 正式命名規則「アポ獲得日(YYYY/MM/DD) 会社名 担当者名」へ全件揃える。
 *  - buildDealTitle() の既存ロジックに完全準拠（appointmentDate 無し→「会社名 担当者名」、
 *    owner 無し→「(日付) 会社名」、company 名無し→ null=スキップして既存タイトル維持）。
 *  - 自動連動（/api/deals/[id] のアポ獲得日/担当者編集時のタイトル再生成）と同じ生成器を使う。
 *
 * 安全策:
 *  - デフォルトはドライラン（--apply で実反映）。
 *  - 接続先 DB を起動時に表示。--prod を付けない限り dev(salesagent_luma) 以外は拒否。
 *    --prod 指定時は Neon(neondb) 以外を拒否。
 *  - 実反映前に「変更前タイトル」を JSON へ退避（id/before/after）。切り戻し用。
 *  - id 基準・件数アサート付き。スキャン件数と更新件数を最後に報告。
 *
 * 使い方:
 *   dev ドライラン : npx tsx --env-file=.env scripts/backfill-deal-titles.ts
 *   dev 実反映     : npx tsx --env-file=.env scripts/backfill-deal-titles.ts --apply
 *   本番ドライラン : npx tsx --env-file=.env.production.local scripts/backfill-deal-titles.ts --prod
 *   本番 実反映    : npx tsx --env-file=.env.production.local scripts/backfill-deal-titles.ts --prod --apply
 */

import { prisma } from "../src/lib/db";
import { buildDealTitle } from "../src/lib/deal-title";
import fs from "fs";
import path from "path";

// 「人手で付けた特殊名」っぽさの簡易判定（報告用。上書きはする）。
// 正式フォーマットは「[YYYY/MM/DD ]会社名[ 担当者名]」。会社名で始まる/日付始まりのものは
// 自動生成由来とみなし、それ以外（会社名を含まない・全く違う書式）を「手動疑い」として件数報告する。
function looksManual(title: string, companyName: string | null | undefined): boolean {
  const company = companyName?.trim();
  if (!company) return false;
  const t = title.trim();
  // 日付プレフィクス（YYYY/MM/DD）を剥がす
  const stripped = t.replace(/^\d{4}\/\d{2}\/\d{2}\s+/, "");
  // 会社名で始まらない＝自動生成フォーマットから外れている可能性
  return !stripped.startsWith(company) && !t.includes(company);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prod = process.argv.includes("--prod");
  const dbUrl = process.env.DATABASE_URL ?? "";
  const masked = dbUrl.replace(/:[^@/]*@/, ":****@");
  console.log(`[${apply ? "APPLY" : "DRY-RUN"}]${prod ? " [PROD]" : " [DEV]"}`);
  console.log(`DATABASE_URL: ${masked}`);

  if (prod) {
    if (!/neon\.tech/.test(dbUrl) || !/neondb/.test(dbUrl)) {
      console.error("ABORT: --prod 指定だが DATABASE_URL が Neon(neondb) を指していません");
      process.exit(1);
    }
  } else {
    if (!dbUrl.includes("salesagent_luma")) {
      console.error("ABORT: DATABASE_URL が salesagent_luma を指していません（本番なら --prod 必須）");
      process.exit(1);
    }
  }

  const deals = await prisma.deal.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      title: true,
      appointmentDate: true,
      company: { select: { name: true } },
      owner: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });
  console.log(`\nscanning ${deals.length} active deals (deletedAt=null)...`);

  type Change = { id: string; before: string; after: string };
  const changes: Change[] = [];
  let withAppt = 0;
  let noAppt = 0;
  let nullSkip = 0; // company名なし→buildDealTitle が null → 既存維持
  let unchanged = 0;
  let manualSuspect = 0;
  const manualSamples: { id: string; before: string; after: string }[] = [];

  for (const d of deals) {
    if (d.appointmentDate) withAppt++;
    else noAppt++;

    const next = buildDealTitle({
      appointmentDate: d.appointmentDate,
      companyName: d.company?.name,
      ownerName: d.owner?.name,
    });

    if (next === null) {
      // 会社名が取れない → 安全側で既存タイトルを維持（空/壊れタイトルを作らない）
      nullSkip++;
      continue;
    }
    if (next === d.title) {
      unchanged++;
      continue;
    }
    if (looksManual(d.title, d.company?.name)) {
      manualSuspect++;
      if (manualSamples.length < 30) {
        manualSamples.push({ id: d.id, before: d.title, after: next });
      }
    }
    changes.push({ id: d.id, before: d.title, after: next });
  }

  console.log(`\n--- breakdown ---`);
  console.log(`active deals          : ${deals.length}`);
  console.log(`  with appointmentDate: ${withAppt}`);
  console.log(`  no appointmentDate  : ${noAppt}`);
  console.log(`null(skip, no company): ${nullSkip}`);
  console.log(`already correct       : ${unchanged}`);
  console.log(`WILL CHANGE           : ${changes.length}`);
  console.log(`  of which manual-suspect: ${manualSuspect}`);

  console.log(`\n--- sample 20 (before -> after) ---`);
  for (const c of changes.slice(0, 20)) {
    console.log(`  [${c.id.slice(0, 8)}] "${c.before}"  ->  "${c.after}"`);
  }

  if (manualSamples.length > 0) {
    console.log(`\n--- manual-suspect samples (上書き対象・参考) ---`);
    for (const c of manualSamples) {
      console.log(`  [${c.id.slice(0, 8)}] "${c.before}"  ->  "${c.after}"`);
    }
  }

  // 退避ログ（before/after 全件）を JSON で保存。dry-run でも保存して内容確認可。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = prod ? "prod" : "dev";
  const mode = apply ? "apply" : "dryrun";
  const outDir = path.join(process.cwd(), "scripts", "backfill-logs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `deal-titles-${tag}-${mode}-${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        meta: {
          db: masked,
          mode,
          tag,
          scanned: deals.length,
          willChange: changes.length,
          nullSkip,
          unchanged,
          manualSuspect,
          generatedAt: new Date().toISOString(),
        },
        changes,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\n退避ログ: ${outFile}`);

  if (!apply) {
    console.log(`\n[DRY-RUN] 反映なし。--apply で実反映。`);
    await prisma.$disconnect();
    return;
  }

  // ===== 実反映 =====
  console.log(`\n[APPLY] ${changes.length}件を更新します...`);
  let updated = 0;
  for (const c of changes) {
    await prisma.deal.update({ where: { id: c.id }, data: { title: c.after } });
    updated++;
    if (updated % 200 === 0) console.log(`  ...${updated}/${changes.length}`);
  }

  // 件数アサート
  if (updated !== changes.length) {
    throw new Error(`ASSERT FAILED: updated(${updated}) !== planned(${changes.length})`);
  }
  console.log(`\n[APPLY DONE] updated=${updated} / planned=${changes.length}`);

  // 検証: 反映後に再スキャンして「残 willChange」が 0（manual fallback の nullSkip 除く）か確認
  const recheck = await prisma.deal.findMany({
    where: { id: { in: changes.map((c) => c.id) } },
    select: {
      id: true,
      title: true,
      appointmentDate: true,
      company: { select: { name: true } },
      owner: { select: { name: true } },
    },
  });
  let mismatch = 0;
  for (const d of recheck) {
    const next = buildDealTitle({
      appointmentDate: d.appointmentDate,
      companyName: d.company?.name,
      ownerName: d.owner?.name,
    });
    if (next !== null && next !== d.title) mismatch++;
  }
  console.log(`[VERIFY] post-update mismatch among changed rows: ${mismatch} (expected 0)`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
