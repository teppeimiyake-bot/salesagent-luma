// Real local app regression. Creates and removes only its own tagged demo records.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { bundleT01Sources, connectDevelopment, newFixture, root } from "./lib/t01-development.mjs";

const fixture = newFixture();
fixture.tag = `t05-manual-browser-${randomUUID()}`;
const db = await connectDevelopment(await bundleT01Sources(), fixture);
let created = false;
try {
  const demo = await db.base.deal.findUnique({
    where: { id: "0d010000-0000-4000-8000-000000000001" }, select: { tenantId: true },
  });
  assert.ok(demo?.tenantId, "Confirmed development demo tenant required");
  fixture.tenant = demo.tenantId;
  await db.base.$transaction(async tx => {
    await tx.company.create({ data: { id: fixture.company, name: "架空企業・T05ブラウザ検証専用",
      note: fixture.tag, createdByTenantId: fixture.tenant } });
    await tx.deal.create({ data: { id: fixture.deal, companyId: fixture.company,
      tenantId: fixture.tenant, title: fixture.tag, meetingOwnerType: "in_person" } });
  });
  created = true;
  const code = await new Promise((resolve, reject) => {
    const child = spawn("python3", ["tests/t05-manual-meeting-app-browser.py"], {
      cwd: root, stdio: "inherit", env: { ...process.env, T05_FIXTURE_DEAL: fixture.deal },
    });
    child.once("error", reject); child.once("exit", resolve);
  });
  assert.equal(code, 0, "Real local T05 browser flow must pass");
  const rows = await db.base.meeting.findMany({ where: { dealId: fixture.deal },
    select: { title: true, meetingDate: true, minutes: true, sourceType: true } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "T05追加・保存確認");
  assert.equal(rows[0].meetingDate.toISOString(), "2026-09-25T00:00:00.000Z");
  assert.match(rows[0].minutes, /予算は80万円。/);
  assert.equal(rows[0].sourceType, "manual_text");
  console.log("PASS: real DB contains exactly one titled, dated manual meeting with edited minutes");
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
        // Database cascades remove this fixture's meetings, BANT logs, and deal only.
        await tx.company.delete({ where: { id: fixture.company } });
        assert.equal(await tx.company.count({ where: { id: fixture.company } }), 0);
        assert.equal(await tx.deal.count({ where: { id: fixture.deal } }), 0);
        assert.equal(await tx.meeting.count({ where: { dealId: fixture.deal } }), 0);
        assert.equal(await tx.aiLog.count({ where: { dealId: fixture.deal } }), 0);
      });
      console.log("PASS: owned temporary company, deal, meetings, and logs removed; user demo unchanged");
    }
  } finally { await db.close(); }
}
