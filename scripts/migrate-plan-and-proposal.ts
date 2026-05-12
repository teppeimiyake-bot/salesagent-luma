/**
 * 既存データ移行（Notion由来 bant.planContents / bant.proposalDocUrl → 新テーブル）
 *
 * 移行内容:
 *   (1) bant.planContents（string[]）→ 各商談の「映像」DealProduct の planProposals に流し込み
 *       - 受注/締結済み（クローズ済み）の DealProduct は一切触らない（yomiStatus に「受注」or「締結済み」を含む行）
 *       - 映像 DealProduct が無い商談、または映像行が全部クローズ済みの商談は対象外（スキップ理由を出力）
 *       - 映像 DealProduct が複数ある場合（クローズ済みを除く）は全てに同じ planProposals をセット
 *       - 既に planProposals が入っている行は上書き（移行は冪等。dry-run で「上書き」表示）
 *   (2) bant.proposalDocUrl（string）→ documents テーブルに sourceType='url' の行として取り込み
 *       - name = 「{取引先企業名} 提案企画書」
 *       - category = 'proposal' / scope = 'deal' / dealId = 当該Deal
 *       - 同一 dealId × 同一 fileUrl の url ドキュメントが既にあればスキップ（冪等）
 *
 * 使い方:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   ドライラン: npx tsx --env-file=.env scripts/migrate-plan-and-proposal.ts
 *   本適用:     npx tsx --env-file=.env scripts/migrate-plan-and-proposal.ts --apply
 *
 * 安全:
 * - DATABASE_URL guard（salesagent_luma 必須）
 * - DRY-RUN がデフォルト
 * - 適用は1つの $transaction（途中失敗で全ロールバック）
 * - クローズ済み DealProduct のスナップショットを取り、トランザクション内＆事後に無傷を検証
 */
import { prisma } from "../src/lib/db";

const CLOSED_YOMI_MARKERS = ["受注", "締結済み"];

function isClosedYomi(yomi: string | null | undefined): boolean {
  if (!yomi) return false;
  return CLOSED_YOMI_MARKERS.some((m) => yomi.includes(m));
}

function safeBant(b: unknown): Record<string, unknown> | null {
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

function planContentsOf(b: Record<string, unknown> | null): string[] {
  if (!b || !Array.isArray(b.planContents)) return [];
  return (b.planContents as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0);
}

function proposalDocUrlOf(b: Record<string, unknown> | null): string | null {
  if (!b) return null;
  return typeof b.proposalDocUrl === "string" && b.proposalDocUrl.length > 0 ? b.proposalDocUrl : null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ローカル(salesagent_luma) または Luma本番(Neon: ...neon.tech/neondb) のみ許可
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

  // 既知の企画提案マスタ名（照合用。マスタに無いタグは「未知タグ」として警告するが移行はする）
  const masters = await prisma.planProposal.findMany({ select: { name: true } });
  const masterNames = new Set(masters.map((m) => m.name));
  console.log(`企画提案マスタ: ${masterNames.size} 件`);

  // ============================================================
  // STEP 0: クローズ済み DealProduct のスナップショット（無傷検証用）
  // ============================================================
  const closedBefore = await prisma.dealProduct.findMany({
    where: { OR: CLOSED_YOMI_MARKERS.map((m) => ({ yomiStatus: { contains: m } })) },
    select: { id: true, productId: true, productName: true, planName: true, planProposals: true, amount: true, yomiStatus: true },
    orderBy: { id: "asc" },
  });
  const closedHashBefore = JSON.stringify(closedBefore);
  console.log(`クローズ済み DealProduct（保護対象）: ${closedBefore.length} 行 / hash長=${closedHashBefore.length}\n`);

  // ============================================================
  // STEP 1: 全 Deal を読み、移行プランを組み立てる
  // ============================================================
  const deals = await prisma.deal.findMany({
    where: { deletedAt: null },
    include: {
      company: { select: { id: true, name: true, deletedAt: true } },
      products: { select: { id: true, productName: true, yomiStatus: true, planProposals: true } },
      documents: { select: { id: true, fileUrl: true, sourceType: true, category: true } },
    },
  });

  // --- (1) planContents → 映像 DealProduct.planProposals ---
  type PlanUpdate = { dealProductId: string; dealId: string; companyName: string; from: string[]; to: string[] };
  const planUpdates: PlanUpdate[] = [];
  let planSkipNoBant = 0;
  let planSkipNoPlanContents = 0;
  let planSkipNoVideoProduct = 0; // 映像 DealProduct がそもそも無い
  let planSkipVideoAllClosed = 0; // 映像 DealProduct が全部クローズ済み
  let planNoChange = 0; // 既に同じ値が入っている
  const unknownTags = new Map<string, number>();
  const dealsWithPlanContents: string[] = [];

  for (const d of deals) {
    if (d.company.deletedAt) continue;
    const b = safeBant(d.bant);
    if (!b) {
      planSkipNoBant += 1;
      continue;
    }
    const pc = planContentsOf(b);
    if (pc.length === 0) {
      planSkipNoPlanContents += 1;
      continue;
    }
    dealsWithPlanContents.push(d.id);
    for (const t of pc) {
      if (!masterNames.has(t)) unknownTags.set(t, (unknownTags.get(t) ?? 0) + 1);
    }
    const videoProducts = d.products.filter((p) => p.productName === "映像");
    if (videoProducts.length === 0) {
      planSkipNoVideoProduct += 1;
      continue;
    }
    const videoOpen = videoProducts.filter((p) => !isClosedYomi(p.yomiStatus));
    if (videoOpen.length === 0) {
      planSkipVideoAllClosed += 1;
      continue;
    }
    for (const vp of videoOpen) {
      if (arraysEqual(vp.planProposals, pc)) {
        planNoChange += 1;
        continue;
      }
      planUpdates.push({
        dealProductId: vp.id,
        dealId: d.id,
        companyName: d.company.name,
        from: vp.planProposals,
        to: pc,
      });
    }
  }

  // --- (2) proposalDocUrl → documents (sourceType='url') ---
  type DocCreate = { dealId: string; companyName: string; url: string; name: string };
  const docCreates: DocCreate[] = [];
  let docSkipNoBant = 0;
  let docSkipNoUrl = 0;
  let docSkipAlreadyExists = 0;
  const dealsWithProposalUrl: string[] = [];

  for (const d of deals) {
    if (d.company.deletedAt) continue;
    const b = safeBant(d.bant);
    if (!b) {
      docSkipNoBant += 1;
      continue;
    }
    const url = proposalDocUrlOf(b);
    if (!url) {
      docSkipNoUrl += 1;
      continue;
    }
    dealsWithProposalUrl.push(d.id);
    const already = d.documents.some((doc) => doc.fileUrl === url);
    if (already) {
      docSkipAlreadyExists += 1;
      continue;
    }
    docCreates.push({
      dealId: d.id,
      companyName: d.company.name,
      url,
      name: `${d.company.name} 提案企画書`,
    });
  }

  // ============================================================
  // STEP 2: レポート出力
  // ============================================================
  console.log("========== (1) planContents → 映像 DealProduct.planProposals ==========");
  console.log(`  planContents を持つ Deal: ${dealsWithPlanContents.length} 件`);
  console.log(`  → 更新する DealProduct 行: ${planUpdates.length} 件`);
  console.log(`     （内 上書き=${planUpdates.filter((u) => u.from.length > 0).length} / 新規セット=${planUpdates.filter((u) => u.from.length === 0).length}）`);
  console.log(`  既に同値で変更不要: ${planNoChange} 行`);
  console.log(`  スキップ内訳:`);
  console.log(`    - bant 無し:                       ${planSkipNoBant} Deal`);
  console.log(`    - planContents 無し:               ${planSkipNoPlanContents} Deal`);
  console.log(`    - 映像 DealProduct が無い:          ${planSkipNoVideoProduct} Deal`);
  console.log(`    - 映像 DealProduct が全部クローズ済: ${planSkipVideoAllClosed} Deal`);
  if (unknownTags.size > 0) {
    console.log(`  ⚠ マスタに無いタグ（移行はするが要確認）: ${unknownTags.size} 種`);
    [...unknownTags.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, c]) => console.log(`      (${c}) ${t}`));
  } else {
    console.log(`  ✓ 全タグがマスタに存在`);
  }
  console.log(`  サンプル（先頭5件）:`);
  planUpdates.slice(0, 5).forEach((u) => {
    console.log(`    [${u.companyName}] dealProduct=${u.dealProductId}`);
    console.log(`        from: [${u.from.join(", ")}]`);
    console.log(`        to:   [${u.to.join(", ")}]`);
  });

  console.log("\n========== (2) proposalDocUrl → documents (sourceType='url') ==========");
  console.log(`  proposalDocUrl を持つ Deal: ${dealsWithProposalUrl.length} 件`);
  console.log(`  → 新規作成する documents 行: ${docCreates.length} 件`);
  console.log(`  スキップ内訳:`);
  console.log(`    - bant 無し:              ${docSkipNoBant} Deal`);
  console.log(`    - proposalDocUrl 無し:    ${docSkipNoUrl} Deal`);
  console.log(`    - 同一URLの行が既存:      ${docSkipAlreadyExists} Deal`);
  console.log(`  サンプル（先頭5件）:`);
  docCreates.slice(0, 5).forEach((d) => {
    console.log(`    [${d.companyName}] name="${d.name}"  url=${d.url.slice(0, 80)}`);
  });

  if (!apply) {
    console.log("\n[DRY-RUN] ここから先は実行しません。--apply で本適用。");
    await prisma.$disconnect();
    return;
  }

  // ============================================================
  // STEP 3: トランザクションで適用
  // ============================================================
  console.log("\n========== STEP 3: トランザクション適用 ==========");
  const result = await prisma.$transaction(async (tx) => {
    let planUpdated = 0;
    for (const u of planUpdates) {
      await tx.dealProduct.update({ where: { id: u.dealProductId }, data: { planProposals: u.to } });
      planUpdated += 1;
    }
    let docCreated = 0;
    for (const d of docCreates) {
      await tx.document.create({
        data: {
          name: d.name,
          category: "proposal",
          sourceType: "url",
          scope: "deal",
          dealId: d.dealId,
          fileUrl: d.url,
          tags: [],
        },
      });
      docCreated += 1;
    }

    // クローズ済み無傷検証（トランザクション内）
    const closedAfter = await tx.dealProduct.findMany({
      where: { OR: CLOSED_YOMI_MARKERS.map((m) => ({ yomiStatus: { contains: m } })) },
      select: { id: true, productId: true, productName: true, planName: true, planProposals: true, amount: true, yomiStatus: true },
      orderBy: { id: "asc" },
    });
    if (JSON.stringify(closedAfter) !== closedHashBefore) {
      throw new Error("PROTECTED (closed) DealProduct rows mutated — rolling back");
    }
    return { planUpdated, docCreated, closedCheck: closedAfter.length };
  }, { timeout: 120_000 });

  console.log(`  DealProduct.planProposals 更新: ${result.planUpdated} 行`);
  console.log(`  documents (url) 新規作成:       ${result.docCreated} 行`);
  console.log(`  クローズ済み保護確認:           ${result.closedCheck} 行 → 無傷`);

  // 事後検証（別接続）
  const closedAfterCommit = await prisma.dealProduct.findMany({
    where: { OR: CLOSED_YOMI_MARKERS.map((m) => ({ yomiStatus: { contains: m } })) },
    select: { id: true, productId: true, productName: true, planName: true, planProposals: true, amount: true, yomiStatus: true },
    orderBy: { id: "asc" },
  });
  if (JSON.stringify(closedAfterCommit) !== closedHashBefore) {
    console.error("!!! 事後検証失敗：クローズ済み DealProduct が変化している !!!");
    process.exit(1);
  }
  console.log(`✓ 事後検証OK：クローズ済み ${closedAfterCommit.length} 行は無傷`);
  console.log("\n========== DONE ==========");
}

main()
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
