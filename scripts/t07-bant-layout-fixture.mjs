// Runs the real development app against isolated, uniquely tagged BANT data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { bundleT01Sources, connectDevelopment, newFixture, root } from "./lib/t01-development.mjs";

const fixture = newFixture();
fixture.tag = `t07-bant-layout-${randomUUID()}`;
const suffix = "担当者から聞き取った内容を整理した段階であり、社内承認や契約を約束するものではない。次回の打ち合わせでは、現在の認識と相違がないかを確認したうえで、不足する情報を一項目ずつ追記する。変更があった場合は、変更理由と確認日も残して関係者へ共有する。";
const fields = {
  budget: "採用広報施策の予算として年間１００万円前後を検討している。動画制作、説明会で使う資料、採用ページへの掲載にかかる費用を含め、複数案の見積もりを比較したいとのこと。\n\n追加の広告費や撮影場所の手配は別途調整する必要があるため、提示金額だけで判断せず、含まれる作業と納品物を明確にする。\n" + suffix,
  authority: "日常の窓口は人事担当者で、制作物の内容確認には広報部門も参加する。正式な決裁者の氏名と役職については、今回の打ち合わせでは確認できていない。\n\n次回は担当者に社内の承認経路を確認し、決裁に必要な比較資料と説明の機会を用意する。既存の業務委託先との調整が必要かも合わせて確認する。\n" + suffix,
  need: "新卒採用において、仕事内容や職場の雰囲気が学生に十分伝わっておらず、説明会参加後の応募につながりにくいことが課題である。現場社員の声を使って日々の働き方を具体的に伝えたい。\n\n応募数だけでなく、志望理由の具体性や内定承諾までの離脱状況も確認し、施策の効果を判断する。\n確認用の架空URL：https://example.invalid/" + "samplecompanyrecruitment".repeat(8) + "\n\n" + suffix,
  timeline: "来年度の採用活動に向けて準備を進めているが、制作開始日や公開日はまだ合意していない。説明会の開催日程が決まった時点で、必要な納期を逆算して検討する。\n\n撮影に参加する社員や確認担当者の予定も踏まえ、企画確認、撮影、編集、最終承認の各段階に十分な期間を設ける。無理な日程で進めず、優先する納品物を相談する。\n" + suffix,
  summary: "採用に関する問題意識は共有できているが、予算と決裁経路、公開時期には確認が必要な点が残っている。現時点の情報だけで受注の可能性や具体的な実施時期を断定しない。\n\n次回は費用に含む範囲、承認者、公開に間に合わせたい行事を確認する。説明資料は二つの案を並べ、違いと追加費用を分かりやすく記載する。\n" + suffix,
};
const db = await connectDevelopment(await bundleT01Sources(), fixture);
let created = false;
try {
  const demo = await db.base.deal.findUnique({
    where: { id: "0d010000-0000-4000-8000-000000000001" }, select: { tenantId: true },
  });
  assert.ok(demo?.tenantId, "Confirmed development demo tenant required");
  fixture.tenant = demo.tenantId;
  await db.base.$transaction(async tx => {
    await tx.company.create({ data: { id: fixture.company, name: "架空企業・T07長文表示検証専用",
      note: fixture.tag, createdByTenantId: fixture.tenant } });
    await tx.deal.create({ data: { id: fixture.deal, companyId: fixture.company,
      tenantId: fixture.tenant, title: fixture.tag, meetingOwnerType: "in_person" } });
  });
  created = true;
  const code = await new Promise((resolve, reject) => {
    const child = spawn("python3", ["tests/t07-bant-layout-app-browser.py"], {
      cwd: root, stdio: "inherit", env: { ...process.env, T07_FIXTURE_DEAL: fixture.deal,
        T07_BANT_FIELDS: JSON.stringify(fields) },
    });
    child.once("error", reject); child.once("exit", resolve);
  });
  assert.equal(code, 0, "Real local T07 BANT browser flow must pass");
  const deal = await db.base.deal.findUnique({ where: { id: fixture.deal }, select: { bant: true } });
  for (const [key, text] of Object.entries(fields)) {
    const expected = key === "timeline" && process.env.T07_BASELINE !== "1" ? "未定" : text;
    assert.equal(deal.bant[key], expected, `${key}: DB must preserve original text and newlines`);
  }
  assert.equal(await db.base.meeting.count({ where: { dealId: fixture.deal } }), 0);
  const logs = await db.base.aiLog.findMany({ where: { dealId: fixture.deal }, select: { step: true } });
  assert.ok(logs.every(log => log.step === "bant_user_edit"), "Only manual-edit audit logs allowed");
  console.log("PASS: actual DB text/newline roundtrip; only manual-edit audit logs, no AI generation");
} finally {
  try {
    if (created) {
      await db.base.$transaction(async tx => {
        const owned = await tx.deal.findUnique({ where: { id: fixture.deal }, include: { company: true } });
        assert.equal(owned?.title, fixture.tag, "Cleanup ownership tag required");
        assert.equal(owned?.tenantId, fixture.tenant);
        assert.equal(owned?.companyId, fixture.company);
        assert.equal(owned?.company.note, fixture.tag);
        assert.equal(owned?.company.createdByTenantId, fixture.tenant);
        assert.equal(await tx.deal.count({ where: { companyId: fixture.company } }), 1);
        await tx.company.delete({ where: { id: fixture.company } });
        assert.equal(await tx.company.count({ where: { id: fixture.company } }), 0);
        assert.equal(await tx.deal.count({ where: { id: fixture.deal } }), 0);
        assert.equal(await tx.meeting.count({ where: { dealId: fixture.deal } }), 0);
        assert.equal(await tx.aiLog.count({ where: { dealId: fixture.deal } }), 0);
      });
      console.log("PASS: owned T07 company/deal/meeting/log counts all zero after cleanup");
    }
  } finally { await db.close(); }
}
