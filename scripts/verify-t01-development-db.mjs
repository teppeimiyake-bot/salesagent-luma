import assert from "node:assert/strict";
import { bundleT01Sources, connectDevelopment, loadSource, newFixture, seedFixture, routeRequest } from "./lib/t01-development.mjs";

const compiled = await bundleT01Sources();
if (process.argv.includes("--check-only")) {
  console.log("T01_SOURCE_BUNDLES_OK_NO_DATABASE_CONNECTION");
} else {
  const fixture = newFixture();
  const env = await connectDevelopment(compiled, fixture);
  const rollback = Error("EXPECTED_ROLLBACK");
  let checks = 0;
  const equal = (a, b) => { assert.equal(a, b); checks++; };
  try {
    await assert.rejects(env.prisma.$transaction(async tx => {
      env.dependencies.prisma = tx;
      const route = loadSource(compiled, "route", env.dependencies);
      await seedFixture(tx, fixture);
      const get = async () => {
        const response = await routeRequest(route, fixture);
        equal(response.status, 200);
        return (await response.json()).deal;
      };
      const patch = body => routeRequest(route, fixture, body);
      let deal = await get();
      equal(deal.meetingStartAt, null);
      equal(deal.meetingEndAt, null);
      equal((await patch({ meetingStartAt: "2026-09-21T14:30:00Z", meetingEndAt: "2026-09-21T15:30:00Z" })).status, 200);
      deal = await get();
      equal(deal.meetingStartAt, "2026-09-21T14:30:00.000Z");
      equal(deal.meetingEndAt, "2026-09-21T15:30:00.000Z");
      equal(deal.meetingScheduledAt, "2026-09-20T15:00:00.000Z");
      equal((await patch({ meetingEndAt: "2026-09-20T00:00:00Z" })).status, 400);
      equal((await get()).meetingEndAt, deal.meetingEndAt);
      equal((await patch({ meetingStartAt: "2026-09-23T01:00:00Z", meetingEndAt: "2026-09-23T02:00:00Z" })).status, 200);
      equal((await get()).meetingScheduledAt, "2026-09-22T15:00:00.000Z");
      equal((await patch({ meetingScheduledAt: "2026-09-25T15:00:00Z" })).status, 200);
      equal((await get()).meetingStartAt, "2026-09-23T01:00:00.000Z");
      env.dependencies.permission = "viewer";
      equal((await patch({ meetingStartAt: null, meetingEndAt: null })).status, 403);
      env.dependencies.permission = "user";
      const originalTenant = env.dependencies.context.tenantId;
      env.dependencies.context.tenantId = newFixture().tenant;
      equal((await patch({ meetingStartAt: null, meetingEndAt: null })).status, 404);
      env.dependencies.context.tenantId = originalTenant;
      equal((await patch({ meetingStartAt: null, meetingEndAt: null })).status, 200);
      deal = await get();
      equal(deal.meetingStartAt, null);
      equal(deal.meetingEndAt, null);
      equal(deal.meetingScheduledAt, null);
      throw rollback;
    }, { maxWait: 15000, timeout: 60000 }), error => error === rollback);
    equal(await env.base.deal.count({ where: { id: fixture.deal } }), 0);
    equal(await env.base.company.count({ where: { id: fixture.company } }), 0);
    equal(await env.base.tenant.count({ where: { id: fixture.tenant } }), 0);
    console.log(`T01_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_FIXTURES_ROLLED_BACK_AI_CALLS_0`);
  } finally {
    await env.close();
  }
}
