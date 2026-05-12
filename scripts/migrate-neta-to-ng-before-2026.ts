/**
 * 2025-12-31 以前の商談（Deal.appointmentDate < 2026-01-01）に紐づく
 * DealProduct のうち yomiStatus が「ネタ」のものを「NG」に一括変更する。
 *
 *  - プレフィックスは保持する：「【映像】ネタ」→「【映像】NG」 / 「ネタ」→「NG」
 *  - probability も 0（NG相当）に更新する
 *  - appointmentDate が NULL の Deal（=商談日不明）は対象外
 *  - 削除済み Deal は対象外
 *
 * 実行：
 *   dry-run : npx tsx --env-file=.env scripts/migrate-neta-to-ng-before-2026.ts
 *   apply   : npx tsx --env-file=.env scripts/migrate-neta-to-ng-before-2026.ts --apply
 *
 * 安全策：
 *   - ローカル(salesagent_luma) または Luma本番(Neon: ...neon.tech/neondb) のみ許可
 *   - apply は単一トランザクション。変更前後の対象行（id / 旧yomi / 旧probability）を出力
 */
import { prisma } from "../src/lib/db";

const CUTOFF = new Date("2026-01-01T00:00:00.000Z"); // 2025-12-31 以前 = この日時より前

function isAllowedDb(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes("salesagent_luma") || url.includes("neon.tech/neondb");
}

async function main() {
  if (!isAllowedDb(process.env.DATABASE_URL)) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma (local) or Luma prod Neon (neondb)");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  console.log(apply ? "[APPLY MODE]" : "[DRY-RUN MODE]");
  console.log(`DB: ${process.env.DATABASE_URL}\n`);

  // 対象 = 削除済みでない Deal で appointmentDate < 2026-01-01、その配下の DealProduct で yomiStatus に「ネタ」を含むもの
  const targets = await prisma.dealProduct.findMany({
    where: {
      yomiStatus: { contains: "ネタ" },
      deal: { deletedAt: null, appointmentDate: { not: null, lt: CUTOFF } },
    },
    select: {
      id: true,
      yomiStatus: true,
      probability: true,
      deal: { select: { id: true, appointmentDate: true, company: { select: { name: true } } } },
    },
    orderBy: [{ deal: { appointmentDate: "asc" } }],
  });

  console.log(`対象 DealProduct: ${targets.length} 件（yomiStatus が「ネタ」かつ商談日 < 2026-01-01）`);

  // 参考：対象外の内訳
  const [netaNoDate, netaAfter] = await Promise.all([
    prisma.dealProduct.count({
      where: { yomiStatus: { contains: "ネタ" }, deal: { deletedAt: null, appointmentDate: null } },
    }),
    prisma.dealProduct.count({
      where: { yomiStatus: { contains: "ネタ" }, deal: { deletedAt: null, appointmentDate: { gte: CUTOFF } } },
    }),
  ]);
  console.log(`  （対象外）商談日が未設定のネタ: ${netaNoDate} 件 / 商談日が2026-01-01以降のネタ: ${netaAfter} 件`);

  // yomiStatus の変換マップを集計
  const byFrom = new Map<string, number>();
  for (const t of targets) {
    const from = t.yomiStatus ?? "(null)";
    byFrom.set(from, (byFrom.get(from) ?? 0) + 1);
  }
  console.log("\n変換内訳（旧 yomiStatus → 新 yomiStatus）:");
  for (const [from, n] of [...byFrom.entries()].sort((a, b) => b[1] - a[1])) {
    const to = from === "(null)" ? "(null のため対象外になるはず)" : from.replace("ネタ", "NG");
    console.log(`  ${from} → ${to} : ${n} 件`);
  }

  console.log("\nサンプル（先頭8件）:");
  for (const t of targets.slice(0, 8)) {
    const d = t.deal.appointmentDate ? t.deal.appointmentDate.toISOString().slice(0, 10) : "?";
    console.log(`  [${t.deal.company.name}] 商談日=${d}  ${t.yomiStatus}(p=${t.probability}) → ${(t.yomiStatus ?? "").replace("ネタ", "NG")}(p=0)`);
  }

  if (!apply) {
    console.log("\n[DRY-RUN] ここから先は実行しません。--apply で本適用。");
    return;
  }

  // ---- APPLY ----
  console.log("\n========== STEP: トランザクション適用 ==========");
  const ids = targets.map((t) => t.id);
  const result = await prisma.$transaction(async (tx) => {
    let updated = 0;
    // 1件ずつ replace するため raw を使う（DB側で「ネタ」→「NG」置換 + probability=0）
    const r = await tx.$executeRaw`
      UPDATE deal_products
      SET yomi_status = replace(yomi_status, 'ネタ', 'NG'),
          probability = 0
      WHERE id = ANY(${ids}::text[])
        AND yomi_status LIKE '%ネタ%'
    `;
    updated = r;
    // 事後検証：対象IDのうち、まだ「ネタ」が残っているものが無いこと
    const leftover = await tx.dealProduct.count({
      where: { id: { in: ids }, yomiStatus: { contains: "ネタ" } },
    });
    if (leftover > 0) {
      throw new Error(`事後検証NG：対象 ${ids.length} 件中 ${leftover} 件にまだ「ネタ」が残っています。ロールバックします。`);
    }
    return { updated, leftover };
  });

  console.log(`  DealProduct 更新（ネタ→NG, probability=0）: ${result.updated} 件`);
  console.log(`  事後検証OK：対象行に「ネタ」残存 0 件`);
  console.log("\n========== DONE ==========");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
