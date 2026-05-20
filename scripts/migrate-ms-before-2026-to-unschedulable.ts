/**
 * ms管理（アポインター向け）データ振り分け：
 * アポ獲得日（Deal.appointmentDate）が 2025-12-31 以前の「ms対象商談」を、
 * ステージ「【商談前】日程調整不可」へ一括で振り分ける。
 *
 * 「ms対象商談」の定義：
 *   - 削除済みでない（deletedAt = null）
 *   - 現在のステージが before グループ（ms管理タブの対象 = 商談予定 / 日程調整不可 / 催促2回送信済）
 *
 * 対象条件：
 *   - 上記 ms対象商談のうち appointmentDate が NOT NULL かつ < 2026-01-01（=2025-12-31 以前）
 *   - すでに「【商談前】日程調整不可」のものは変更不要のためスキップ
 *   - appointmentDate が NULL（アポ獲得日不明）の商談は対象外
 *
 * 実行（必ず ASCII パス C:\dev\salesagent-luma から）：
 *   dry-run : npx tsx --env-file=.env scripts/migrate-ms-before-2026-to-unschedulable.ts
 *   apply   : npx tsx --env-file=.env scripts/migrate-ms-before-2026-to-unschedulable.ts --apply
 *
 * 安全策：
 *   - ローカル DB（salesagent_luma）のみ許可。本番 Neon は明示的に拒否（社長の指示を待つ）。
 *   - apply は単一トランザクション。事後検証で対象行が全件移動済みであることを確認。
 */
import { prisma } from "../src/lib/db";

const CUTOFF = new Date("2026-01-01T00:00:00.000Z"); // 2025-12-31 以前 = この日時より前
const TARGET_STAGE = "【商談前】日程調整不可";

/** ローカル salesagent_luma のみ許可（本番 Neon は拒否） */
function isLocalLumaDb(url: string | undefined): boolean {
  if (!url) return false;
  if (url.includes("neon.tech")) return false; // 本番は明示拒否
  return url.includes("salesagent_luma") && url.includes("localhost");
}

async function main() {
  if (!isLocalLumaDb(process.env.DATABASE_URL)) {
    console.error(
      "ABORT: DATABASE_URL must point to LOCAL salesagent_luma (localhost). " +
        "本番 Neon への実行は禁止です（社長の指示を待つ）。",
    );
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  console.log(apply ? "[APPLY MODE]" : "[DRY-RUN MODE]");
  console.log(`DB: ${process.env.DATABASE_URL}`);
  console.log(`CUTOFF: appointmentDate < ${CUTOFF.toISOString()} (=2025-12-31 以前)`);
  console.log(`TARGET STAGE: ${TARGET_STAGE}\n`);

  // before グループのステージ value 一覧（ms管理タブの対象範囲）
  const beforeStages = (
    await prisma.pipelineStage.findMany({
      where: { group: "before" },
      select: { value: true, label: true },
    })
  ).map((s) => s.value);

  if (!beforeStages.includes(TARGET_STAGE)) {
    console.error(
      `ABORT: 振り分け先ステージ「${TARGET_STAGE}」が before グループに存在しません。` +
        `管理者メニューの「商談プロセス」を確認してください。`,
    );
    process.exit(1);
  }

  // 対象 = ms対象（before グループ・未削除）のうち appointmentDate < cutoff、
  //        かつ すでに TARGET_STAGE のものは除外
  const targets = await prisma.deal.findMany({
    where: {
      deletedAt: null,
      pipelineStage: { in: beforeStages, not: TARGET_STAGE },
      appointmentDate: { not: null, lt: CUTOFF },
    },
    select: {
      id: true,
      title: true,
      pipelineStage: true,
      appointmentDate: true,
      company: { select: { name: true } },
    },
    orderBy: [{ appointmentDate: "asc" }],
  });

  console.log(
    `対象 Deal: ${targets.length} 件（before グループ・appointmentDate < cutoff・現在 ${TARGET_STAGE} 以外）`,
  );

  // 参考：対象外の内訳
  const [alreadyTarget, noAppt, afterCutoff] = await Promise.all([
    prisma.deal.count({
      where: {
        deletedAt: null,
        pipelineStage: TARGET_STAGE,
        appointmentDate: { not: null, lt: CUTOFF },
      },
    }),
    prisma.deal.count({
      where: {
        deletedAt: null,
        pipelineStage: { in: beforeStages },
        appointmentDate: null,
      },
    }),
    prisma.deal.count({
      where: {
        deletedAt: null,
        pipelineStage: { in: beforeStages },
        appointmentDate: { gte: CUTOFF },
      },
    }),
  ]);
  console.log(
    `  （対象外）すでに ${TARGET_STAGE}: ${alreadyTarget} 件 / ` +
      `アポ獲得日未設定: ${noAppt} 件 / アポ獲得日が2026-01-01以降: ${afterCutoff} 件`,
  );

  // 現在ステージ別の内訳
  const byStage = new Map<string, number>();
  for (const t of targets) {
    const k = t.pipelineStage ?? "(null)";
    byStage.set(k, (byStage.get(k) ?? 0) + 1);
  }
  console.log("\n移動内訳（現在ステージ → 日程調整不可）:");
  for (const [from, n] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${from} → ${TARGET_STAGE} : ${n} 件`);
  }

  console.log("\nサンプル（先頭8件）:");
  for (const t of targets.slice(0, 8)) {
    const d = t.appointmentDate
      ? t.appointmentDate.toISOString().slice(0, 10)
      : "?";
    console.log(
      `  [${t.company.name}] アポ獲得日=${d}  ${t.pipelineStage} → ${TARGET_STAGE}`,
    );
  }

  if (!apply) {
    console.log("\n[DRY-RUN] ここから先は実行しません。--apply で本適用。");
    return;
  }

  if (targets.length === 0) {
    console.log("\n対象 0 件のため、適用はスキップします。");
    return;
  }

  // ---- APPLY ----
  console.log("\n========== STEP: トランザクション適用 ==========");
  const ids = targets.map((t) => t.id);
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.deal.updateMany({
      where: { id: { in: ids } },
      data: { pipelineStage: TARGET_STAGE },
    });
    // 事後検証：対象IDが全件 TARGET_STAGE になったか
    const leftover = await tx.deal.count({
      where: { id: { in: ids }, pipelineStage: { not: TARGET_STAGE } },
    });
    if (leftover > 0) {
      throw new Error(
        `事後検証NG：対象 ${ids.length} 件中 ${leftover} 件が ${TARGET_STAGE} になっていません。ロールバックします。`,
      );
    }
    return { updated: updated.count, leftover };
  });

  console.log(`  Deal 更新（→ ${TARGET_STAGE}）: ${result.updated} 件`);
  console.log(`  事後検証OK：対象行で ${TARGET_STAGE} 以外 0 件`);
  console.log("\n========== DONE ==========");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
