/**
 * 業種マスタ（Industry）の初期投入。
 *
 * 方針:
 * - 静的 INDUSTRY_OPTIONS を中核に投入（並び順は配列順）。
 * - さらに、既存 Company.industry に実際に入っている業種値（「,」分割）も拾って投入する。
 *   → 既存データの業種が選択肢から欠落しないようにする（マスタ化後も後方互換）。
 * - 既に同名がある場合はスキップ（upsert 相当・冪等）。
 *
 * 安全装置: DATABASE_URL が salesagent_luma を指していない場合は実行しない。
 */
import { prisma } from "../src/lib/db";
import { INDUSTRY_OPTIONS, parseIndustries } from "../src/lib/industry";
import { LUMA_TENANT_ID } from "./tenant-ids";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("salesagent_luma")) {
    throw new Error(
      `安全装置: DATABASE_URL が salesagent_luma を指していません（${url.replace(/:\/\/[^@]*@/, "://***@")}）。中断します。`,
    );
  }

  // 1) 静的リストを順序付きで採用
  const ordered: string[] = [...INDUSTRY_OPTIONS];

  // 2) 既存企業の業種値を拾って追加（静的に無いものを末尾に）
  const companies = await prisma.company.findMany({
    where: { deletedAt: null },
    select: { industry: true },
  });
  const seen = new Set(ordered);
  for (const c of companies) {
    for (const name of parseIndustries(c.industry)) {
      if (!seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }

  // 「その他」は常に末尾に来るよう並べ直す
  const withoutOther = ordered.filter((n) => n !== "その他");
  const finalOrder = [...withoutOther, "その他"];

  let created = 0;
  let skipped = 0;
  for (let i = 0; i < finalOrder.length; i++) {
    const name = finalOrder[i];
    const exists = await prisma.industry.findUnique({ where: { tenantId_name: { tenantId: LUMA_TENANT_ID, name } } });
    if (exists) {
      skipped++;
      continue;
    }
    await prisma.industry.create({
      data: { name, active: true, sortOrder: i + 1 },
    });
    created++;
  }

  console.log(`業種マスタ投入完了: ${created} 件作成 / ${skipped} 件スキップ（既存）。合計 ${finalOrder.length} 種。`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
