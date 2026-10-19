// Real development Neon, tenant extension, T02 route/library; Google is simulated.
// All new demo rows, including the auth fixture, are rolled back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bundleT01Sources, connectDevelopment, newFixture, seedFixture } from "./lib/t01-development.mjs";
import { loadT02, fakeEnv, ready, pending, postMeet } from "../tests/helpers/t02-harness.mjs";

const compiled = await bundleT01Sources();
const fixture = newFixture(); fixture.tag = fixture.tag.replace("t01-", "t02-");
const userId = randomUUID();
const env = await connectDevelopment(compiled, fixture);
const rollback = Error("EXPECTED_ROLLBACK");
let checks = 0;
const equal = (a, b) => { assert.equal(a, b); checks++; };
try {
  await assert.rejects(env.prisma.$transaction(async tx => {
    await seedFixture(tx, fixture);
    await tx.user.create({ data: { id: userId, email: `${fixture.tag}@example.invalid`, name: "T02デモ担当", permission: "user" } });
    // Meet issuance is limited to own Meet deals (409 OWN_MEET_REQUIRED otherwise).
    await tx.deal.update({ where: { id: fixture.deal }, data: {
      meetingOwnerType: "own_meet",
      meetingStartAt: new Date("2026-09-24T01:00:00Z"), meetingEndAt: new Date("2026-09-24T02:00:00Z"),
      meetSpaceName: "spaces/old-demo", meetArtifactAttempts: 5,
    } });
    let inserts = 0;
    const patches = [];
    const mocks = { env: fakeEnv(), session: { userId }, prisma: tx,
      configureArtifacts: () => { throw Error("ARTIFACT_CALL_NOT_ALLOWED"); },
      calendar: { events: {
        insert: async args => { inserts++; return { data: pending(args.requestBody.id) }; },
        patch: async args => { patches.push(args); return { data: ready(args.eventId) }; },
      } },
    };
    const { route } = await loadT02(mocks);
    const post = body => postMeet(route, fixture.deal, body);
    let response = await post({}); equal(response.status, 202);
    const firstId = (await response.json()).deal.meetEventId;
    let stored = await tx.deal.findUnique({ where: { id: fixture.deal } });
    equal(stored.meetEventId, firstId); equal(stored.meetUrl, null);
    equal(stored.meetSpaceName, null); equal(stored.meetArtifactAttempts, 0);

    response = await post({}); equal(response.status, 200);
    stored = await tx.deal.findUnique({ where: { id: fixture.deal } });
    equal(stored.meetEventId, firstId); equal(stored.meetUrl, ready().hangoutLink);
    equal(stored.meetingOwnerType, "own_meet"); equal(inserts, 1);
    await tx.deal.update({ where: { id: fixture.deal }, data: {
      meetingStartAt: new Date("2026-09-25T01:00:00Z"), meetingEndAt: new Date("2026-09-25T02:00:00Z"),
    } });
    equal((await post({})).status, 200);
    equal(patches.at(-1).eventId, firstId);
    equal(patches.at(-1).requestBody.start.dateTime, "2026-09-25T01:00:00.000Z");
    equal(inserts, 1);

    response = await post({ forceRecreate: true, expectedEventId: firstId }); equal(response.status, 202);
    const replacementId = (await response.json()).deal.meetEventId;
    equal(replacementId !== firstId, true);
    equal((await post({ forceRecreate: true, expectedEventId: firstId })).status, 409);
    equal(inserts, 2);
    equal((await post({})).status, 200);
    equal((await tx.deal.findUnique({ where: { id: fixture.deal } })).meetEventId, replacementId);

    const ownTenant = env.dependencies.context.tenantId;
    env.dependencies.context.tenantId = randomUUID();
    equal((await post({})).status, 404);
    env.dependencies.context.tenantId = ownTenant;
    await tx.user.update({ where: { id: userId }, data: { permission: "viewer" } });
    equal((await post({})).status, 403);
    equal(inserts, 2);
    throw rollback;
  }, { maxWait: 15000, timeout: 60000 }), error => error === rollback);
  for (const [model, id] of [["deal", fixture.deal], ["company", fixture.company], ["tenant", fixture.tenant], ["user", userId]]) {
    equal(await env.base[model].count({ where: { id } }), 0);
  }
  console.log(`T02_DEVELOPMENT_DB_PASS_${checks}_ASSERTIONS_ROLLED_BACK_EXTERNAL_CALLS_0`);
} finally { await env.close(); }
