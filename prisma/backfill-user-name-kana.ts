/**
 * User.nameKana（氏名フリガナ・カタカナ）バックフィル。
 *
 * 担当者をカタカナ読みでも検索できるようにするため、既知のLuma社員のフリガナを投入する。
 * - email を一次キーに照合（name は表記ゆれの可能性があるため）。
 * - 既に nameKana が入っているレコードは上書きしない（手動修正を尊重）。
 * - マスタに無いユーザーはスキップ（後から admin で設定可能にする想定）。
 *
 * 安全装置: DATABASE_URL が salesagent_luma を指していない場合は実行しない。
 */
import { prisma } from "../src/lib/db";

const KANA_BY_EMAIL: Record<string, string> = {
  "teppei.miyake@luma-create.com": "ミヤケテッペイ",
  "ren.sakai.luma@gmail.com": "サカイレン",
  "mao.sobata.luma@gmail.com": "ソバタマオ",
  "rui.katamoto@luma-create.com": "カタモトルイ",
  "riku.shimizu.luma@gmail.com": "シミズリク",
  "rinko.kawamoto.luma@gmail.com": "カワモトリンコ",
  "rui.yamaguchi@luma-create.com": "ヤマグチルイ",
  "toa.matsumoto.luma@gmail.com": "マツモトトア",
  "rino.makino@luma-create.com": "マキノリノ",
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("salesagent_luma")) {
    throw new Error(
      `安全装置: DATABASE_URL が salesagent_luma を指していません（${url.replace(/:\/\/[^@]*@/, "://***@")}）。中断します。`,
    );
  }

  let updated = 0;
  let skipped = 0;
  for (const [email, kana] of Object.entries(KANA_BY_EMAIL)) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, nameKana: true } });
    if (!user) {
      console.log(`[skip] not found: ${email}`);
      continue;
    }
    if (user.nameKana && user.nameKana.trim()) {
      console.log(`[keep] ${user.name} は既にフリガナ設定済み（${user.nameKana}）`);
      skipped++;
      continue;
    }
    await prisma.user.update({ where: { id: user.id }, data: { nameKana: kana } });
    console.log(`[set ] ${user.name} → ${kana}`);
    updated++;
  }
  console.log(`\n完了: ${updated} 件設定 / ${skipped} 件スキップ（既設定）`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
