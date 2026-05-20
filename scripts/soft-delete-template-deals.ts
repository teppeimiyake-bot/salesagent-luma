/**
 * テンプレ商談のソフト削除：
 * 「【複製して使用】商談議事録テンプレ」等の、実商談ではないテンプレ用 Deal を
 * ソフト削除（deletedAt セット）して ms管理ボード・各一覧から除外する。
 *
 * 背景：
 *   - これらは複製の元ネタとして作られたテンプレ商談で、実顧客の商談ではない。
 *   - ms管理タブ（#5 の日程調整不可振り分け）に混入していたため除外したい。
 *   - 復旧可能性を残すためソフト削除（deletedAt）を採用。物理削除はしない。
 *
 * 削除対象の定義（タイトルパターン・OR）：
 *   - title に「【複製して使用】」を含む
 *   - title に「商談議事録テンプレ」を含む
 *   - title に「テンプレ」を含み、かつ「【複製」または「複製して」を含む（保険）
 *   ※ 実商談を巻き込まないよう、まず dry-run で全候補のタイトル・会社・関連件数を確認すること。
 *
 * 実行（必ず ASCII パス C:\dev\salesagent-luma から）：
 *   ローカル dry-run : npx tsx --env-file=.env scripts/soft-delete-template-deals.ts
 *   ローカル apply   : npx tsx --env-file=.env scripts/soft-delete-template-deals.ts --apply
 *   本番   dry-run   : npx tsx --env-file=.env.production.local scripts/soft-delete-template-deals.ts --prod
 *   本番   apply     : npx tsx --env-file=.env.production.local scripts/soft-delete-template-deals.ts --prod --apply
 *
 * 安全策：
 *   - 本番 Neon（neondb / neon.tech）への接続は --prod フラグが無い限り拒否。
 *   - --prod 無しでは localhost の salesagent_luma のみ許可。
 *   - apply は単一トランザクション。事後検証で対象が全件 deletedAt 済みか確認。
 *   - すでに deletedAt 済みのものは対象外。
 */
import { prisma } from "../src/lib/db";

const PROD = process.argv.includes("--prod");
const APPLY = process.argv.includes("--apply");

/** 接続先の安全判定 */
function assertSafeTarget(url: string | undefined) {
  if (!url) {
    console.error("ABORT: DATABASE_URL が未設定です。");
    process.exit(1);
  }
  const isNeon = url.includes("neon.tech");
  const isLocalLuma = url.includes("salesagent_luma") && url.includes("localhost");
  if (PROD) {
    // 本番モード：必ず Neon の neondb であること
    if (!isNeon || !url.includes("/neondb")) {
      console.error(
        "ABORT: --prod 指定だが DATABASE_URL が Neon の neondb を指していません。" +
          `（host/db を確認）`,
      );
      process.exit(1);
    }
  } else {
    // 非本番：localhost の salesagent_luma のみ許可、Neon は拒否
    if (isNeon) {
      console.error(
        "ABORT: 本番 Neon に接続しようとしています。本番に対しては --prod を明示してください。",
      );
      process.exit(1);
    }
    if (!isLocalLuma) {
      console.error("ABORT: DATABASE_URL が localhost の salesagent_luma を指していません。");
      process.exit(1);
    }
  }
}

/** title 候補のマッチ条件（Prisma where の OR） */
const TITLE_OR = [
  { title: { contains: "【複製して使用】" } },
  { title: { contains: "商談議事録テンプレ" } },
  { title: { contains: "複製して使用" } },
];

async function main() {
  assertSafeTarget(process.env.DATABASE_URL);

  // 接続先の host/db を表示（パスワードは出さない）
  let host = "?";
  let db = "?";
  try {
    const u = new URL((process.env.DATABASE_URL as string).replace(/^postgres(ql)?:/, "http:"));
    host = u.hostname;
    db = u.pathname.replace(/^\//, "").split("?")[0];
  } catch {
    /* noop */
  }

  console.log(`MODE: ${PROD ? "PROD(Neon)" : "LOCAL"} / ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`TARGET DB: host=${host} db=${db}`);
  if (PROD && (host.indexOf("neon.tech") === -1 || db !== "neondb")) {
    console.error("ABORT: 想定外の本番接続先です（neon.tech / neondb 以外）。");
    process.exit(1);
  }
  console.log("");

  // ---- 候補抽出（未削除のみ） ----
  const candidates = await prisma.deal.findMany({
    where: {
      deletedAt: null,
      OR: TITLE_OR,
    },
    select: {
      id: true,
      title: true,
      pipelineStage: true,
      status: true,
      appointmentDate: true,
      createdAt: true,
      company: { select: { id: true, name: true } },
      _count: {
        select: {
          meetings: true,
          products: true,
          tasks: true,
          documents: true,
          aiLogs: true,
          roleplays: true,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  console.log(`削除候補（未削除・タイトルパターン一致）: ${candidates.length} 件\n`);

  // ステージ別内訳
  const byStage = new Map<string, number>();
  for (const c of candidates) {
    const k = c.pipelineStage ?? "(null)";
    byStage.set(k, (byStage.get(k) ?? 0) + 1);
  }
  console.log("ステージ別内訳:");
  for (const [s, n] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s} : ${n} 件`);
  }
  console.log("");

  // 全候補のサンプル表示（実商談の巻き込みチェック用に最大40件）
  console.log("候補一覧（最大40件・タイトル / 会社 / ステージ / 関連件数）:");
  for (const c of candidates.slice(0, 40)) {
    const cnt = c._count;
    console.log(
      `  - "${c.title}" | 会社=${c.company.name} | ${c.pipelineStage ?? "(null)"} | ` +
        `meet=${cnt.meetings} prod=${cnt.products} task=${cnt.tasks} doc=${cnt.documents} ai=${cnt.aiLogs} rp=${cnt.roleplays}`,
    );
  }
  if (candidates.length > 40) console.log(`  ...他 ${candidates.length - 40} 件`);
  console.log("");

  if (!APPLY) {
    console.log("[DRY-RUN] ソフト削除は実行しません。--apply で適用。");
    return;
  }
  if (candidates.length === 0) {
    console.log("対象 0 件のため適用スキップ。");
    return;
  }

  // ---- APPLY: ソフト削除（deletedAt セット） ----
  console.log("========== STEP: トランザクションでソフト削除 ==========");
  const ids = candidates.map((c) => c.id);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.deal.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { deletedAt: now },
    });
    // 事後検証：対象IDが全件 deletedAt 済みか
    const leftover = await tx.deal.count({
      where: { id: { in: ids }, deletedAt: null },
    });
    if (leftover > 0) {
      throw new Error(
        `事後検証NG：対象 ${ids.length} 件中 ${leftover} 件が未削除のまま。ロールバックします。`,
      );
    }
    return { updated: updated.count, leftover };
  });

  console.log(`  ソフト削除（deletedAt セット）: ${result.updated} 件`);
  console.log(`  事後検証OK：対象IDで deletedAt=null は 0 件`);

  // ms ボードに残っていないことの確認（before グループ × 未削除 × タイトル一致）
  const remainInMs = await prisma.deal.count({
    where: { deletedAt: null, OR: TITLE_OR },
  });
  console.log(`  未削除のテンプレ商談（タイトル一致）: ${remainInMs} 件（0 であるべき）`);
  console.log("\n========== DONE ==========");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
