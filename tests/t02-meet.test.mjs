import assert from "node:assert/strict";
import { test } from "node:test";
import { loadT02, fakeEnv, ready, pending, postMeet } from "./helpers/t02-harness.mjs";

const input = { operationKey: "tenant:deal", summary: "架空企業の商談",
  startAt: new Date("2026-09-24T01:00:00Z"), endAt: new Date("2026-09-24T02:00:00Z") };

async function harness() {
  const state = { inserts: [], patches: [], updates: [], writes: 0, artifacts: 0, conflict: false, permission: "user",
    deal: { id: "deal", tenantId: "tenant", title: "デモ商談", deletedAt: null, meetingOwnerType: "own_meet",
      meetingStartAt: input.startAt, meetingEndAt: input.endAt, meetEventId: null, meetUrl: null,
      company: { name: "架空企業", deletedAt: null }, owner: { name: "デモ担当者" },
      meetSpaceName: "spaces/old", meetArtifactAttempts: 7,
    },
    insert: async args => ({ data: ready(args.requestBody.id) }),
    patch: async args => ({ data: ready(args.eventId) }),
  };
  const mocks = { env: fakeEnv(), session: { userId: "user" }, calendar: { events: {
    insert: async args => { state.inserts.push(args); return state.insert(args); },
    patch: async args => { state.patches.push(args); return state.patch(args); },
  } }, prisma: {
    user: { findUnique: async () => state.permission ? { permission: state.permission } : null },
    deal: {
      findUnique: async () => structuredClone(state.deal),
      update: async ({ where, data }) => {
        state.updates.push({ where, data });
        if (state.conflict || where.meetEventId !== state.deal.meetEventId
          || (where.meetingOwnerType !== undefined && where.meetingOwnerType !== state.deal.meetingOwnerType)) {
          throw Object.assign(Error("changed"), { code: "P2025" });
        }
        state.writes++; Object.assign(state.deal, data); return structuredClone(state.deal);
      },
    },
  }, configureArtifacts: async () => { state.artifacts++; return { status: "configured", ok: true }; } };
  const actual = await loadT02(mocks);
  return { ...actual, state, mocks, post: body => postMeet(actual.route, "deal", body) };
}

test("creation supplies JST calendar times and a stable valid event ID", async () => {
  const h = await harness();
  const result = await h.meet.upsertMeetEvent(input);
  assert.equal(result.status, "ready");
  const { requestBody, conferenceDataVersion } = h.state.inserts[0];
  assert.equal(conferenceDataVersion, 1);
  assert.equal(requestBody.start.timeZone, "Asia/Tokyo");
  assert.equal(requestBody.start.dateTime, input.startAt.toISOString());
  assert.match(requestBody.id, /^[a-v0-9]{5,1024}$/);
  await h.meet.upsertMeetEvent(input);
  assert.equal(h.state.inserts[1].requestBody.id, requestBody.id);
  await h.meet.upsertMeetEvent({ ...input, operationKey: "other:deal" });
  assert.notEqual(h.state.inserts[2].requestBody.id, requestBody.id);
});

test("rescheduling patches the same event without replacing its conference", async () => {
  const h = await harness();
  const result = await h.meet.upsertMeetEvent({ ...input, eventId: "existing" });
  assert.equal(result.eventId, "existing");
  assert.equal(result.meetUrl, ready().hangoutLink);
  assert.equal(h.state.inserts.length, 0);
  assert.equal(h.state.patches[0].requestBody.conferenceData, undefined);
});

test("reissue creates a different event but repeats use the same replacement ID", async () => {
  const h = await harness();
  const request = { ...input, eventId: "old", forceRecreate: true };
  const a = await h.meet.upsertMeetEvent(request);
  const b = await h.meet.upsertMeetEvent(request);
  assert.notEqual(a.eventId, "old");
  assert.equal(a.eventId, b.eventId);
});

test("a lost insert response is recovered from a conflict, using the same event", async () => {
  const h = await harness();
  h.state.insert = async () => { throw { response: { status: 409 } }; };
  const result = await h.meet.upsertMeetEvent(input);
  assert.equal(result.eventId, h.state.inserts[0].requestBody.id);
  assert.equal(h.state.patches[0].eventId, result.eventId);
});

for (const status of [404, 410]) test(`missing/deleted event (${status}) is replaced`, async () => {
  const h = await harness();
  h.state.patch = async () => { throw { response: { status } }; };
  const result = await h.meet.upsertMeetEvent({ ...input, eventId: "gone" });
  assert.equal(result.status, "ready");
  assert.notEqual(result.eventId, "gone");
});

test("permission and quota errors never fall back to creating another event", async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = await harness();
    h.state.patch = async () => { throw { code: status }; };
    await assert.rejects(h.meet.upsertMeetEvent({ ...input, eventId: "existing" }));
    assert.equal(h.state.inserts.length, 0);
  }
});

test("pending creation retains its event ID without claiming a URL", async () => {
  const h = await harness();
  h.state.insert = async args => ({ data: pending(args.requestBody.id) });
  const result = await h.meet.upsertMeetEvent(input);
  assert.equal(result.status, "pending"); assert.equal(result.meetUrl, null);
  h.state.patch = async args => ({ data: pending(args.eventId) });
  const again = await h.meet.upsertMeetEvent({ ...input, eventId: result.eventId });
  assert.equal(again.eventId, result.eventId);
  assert.equal(h.state.patches.length, 1);
  assert.equal(h.state.inserts.length, 1);
});

test("failed conference generation is retried on the existing event", async () => {
  const h = await harness();
  h.state.patch = async args => ({ data: h.state.patches.length === 1
    ? { id: args.eventId, conferenceData: { createRequest: { status: { statusCode: "failure" } } } }
    : ready(args.eventId) });
  assert.equal((await h.meet.upsertMeetEvent({ ...input, eventId: "existing" })).status, "ready");
  assert.equal(h.state.patches.length, 2);
  assert.ok(h.state.patches[1].requestBody.conferenceData.createRequest.requestId);
  assert.equal(h.state.inserts.length, 0);
});

test("invalid external URL is not persisted as a usable Meet link", async () => {
  const h = await harness();
  h.state.insert = async args => ({ data: { id: args.requestBody.id, hangoutLink: "javascript:alert(1)" } });
  const result = await h.meet.upsertMeetEvent(input);
  assert.equal(result.meetUrl, null); assert.equal(result.status, "failed");
});

test("missing credentials and invalid dates stop before any Google operation", async () => {
  const h = await harness();
  h.mocks.env.GOOGLE_MEET_REFRESH_TOKEN = " ";
  await assert.rejects(h.meet.upsertMeetEvent(input), { name: "GoogleMeetConfigError" });
  h.mocks.env.GOOGLE_MEET_REFRESH_TOKEN = "test-only";
  for (const endAt of [input.startAt, new Date("invalid")]) {
    await assert.rejects(h.meet.upsertMeetEvent({ ...input, endAt }), { name: "GoogleMeetOperationError" });
  }
  assert.equal(h.state.inserts.length + h.state.patches.length, 0);
});

test("actual API persists links and resets old Meet artifact state", async () => {
  const h = await harness(); h.mocks.env.FEATURE_MEET_AUTO_RECORD = "1";
  const response = await h.post({});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deal.meetUrl, ready().hangoutLink);
  assert.equal(h.state.deal.meetSpaceName, null);
  assert.equal(h.state.deal.meetArtifactAttempts, 0);
  assert.equal(h.state.artifacts, 1);
});

test("pending API response is 202, stores the event and skips artifact configuration", async () => {
  const h = await harness(); h.mocks.env.FEATURE_MEET_AUTO_RECORD = "1";
  h.state.insert = async args => ({ data: pending(args.requestBody.id) });
  const response = await h.post({});
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "pending");
  assert.ok(h.state.deal.meetEventId); assert.equal(h.state.deal.meetUrl, null);
  assert.equal(h.state.artifacts, 0);
  assert.equal((await h.post({})).status, 200);
  assert.equal(h.state.inserts.length, 1);
});

test("failed conference still retains an event ID for retry", async () => {
  const h = await harness();
  h.state.insert = async args => ({ data: { id: args.requestBody.id,
    conferenceData: { createRequest: { status: { statusCode: "failure" } } } } });
  assert.equal((await h.post({})).status, 502);
  assert.ok(h.state.deal.meetEventId); assert.equal(h.state.deal.meetUrl, null);
});

test("feature flag, auth, permission, malformed JSON and date guards stop Google", async () => {
  const h = await harness();
  h.mocks.env.FEATURE_MEET = "0"; assert.equal((await h.post({})).status, 404);
  h.mocks.env.FEATURE_MEET = "1"; h.mocks.session = null; assert.equal((await h.post({})).status, 401);
  h.mocks.session = { userId: "user" }; h.state.permission = "viewer"; assert.equal((await h.post({})).status, 403);
  h.state.permission = null; assert.equal((await h.post({})).status, 403);
  h.state.permission = "user"; assert.equal((await h.post("{broken")).status, 400);
  h.state.deal.meetingEndAt = input.startAt; assert.equal((await h.post({})).status, 400);
  h.state.deal.meetingStartAt = null; assert.equal((await h.post({})).status, 400);
  assert.equal(h.state.inserts.length + h.state.patches.length, 0);
});

test("missing and soft-deleted deals/companies stop Google", async () => {
  const h = await harness();
  h.state.deal.company.deletedAt = new Date(); assert.equal((await h.post({})).status, 410);
  h.state.deal.company.deletedAt = null; h.state.deal.deletedAt = new Date(); assert.equal((await h.post({})).status, 410);
  h.state.deal = null; assert.equal((await h.post({})).status, 404);
  assert.equal(h.state.inserts.length, 0);
});

test("stale reissue requests are rejected before another event is created", async () => {
  const h = await harness(); h.state.deal.meetEventId = "newer";
  assert.equal((await h.post({ forceRecreate: true, expectedEventId: "old" })).status, 409);
  assert.equal(h.state.inserts.length, 0);
});

test("concurrent DB edits are not overwritten", async () => {
  const h = await harness(); h.state.conflict = true;
  assert.equal((await h.post({})).status, 409);
  assert.equal(h.state.writes, 0);
});

test("configuration failures are actionable and raw Google errors are not exposed", async () => {
  const h = await harness(); h.mocks.env.GOOGLE_MEET_CLIENT_ID = "";
  assert.equal((await h.post({})).status, 503);
  h.mocks.env.GOOGLE_MEET_CLIENT_ID = "test-only";
  h.state.insert = async () => { throw Error("sensitive upstream token"); };
  const response = await h.post({}); assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /sensitive upstream token/);
  assert.equal(h.state.writes, 0);
});

test("guest Meet, Zoom, in-person and unselected deals never issue our Meet", async () => {
  for (const owner of ["guest_meet", "zoom", "in_person", "unknown"]) {
    for (const body of [{}, { forceRecreate: true, expectedEventId: null }]) {
      const h = await harness(); h.mocks.env.FEATURE_MEET_AUTO_RECORD = "1"; h.state.deal.meetingOwnerType = owner;
      const response = await h.post(body);
      assert.equal(response.status, 409, owner);
      const json = await response.json();
      assert.equal(json.code, "OWN_MEET_REQUIRED");
      assert.match(json.message, /自社発行の Google Meet/);
      assert.equal(h.state.inserts.length + h.state.patches.length, 0);
      assert.equal(h.state.updates.length, 0); assert.equal(h.state.artifacts, 0);
      assert.equal(h.state.deal.meetingOwnerType, owner);
    }
  }
});

test("issuance keeps the stored owner type and requires own Meet at write time", async () => {
  const h = await harness();
  assert.equal((await h.post({})).status, 200);
  const [{ where, data }] = h.state.updates;
  assert.equal(where.meetingOwnerType, "own_meet");
  assert.equal("meetingOwnerType" in data, false);
  assert.equal(h.state.deal.meetingOwnerType, "own_meet");
});

test("owner type switched away during issuance is not overwritten back to own Meet", async () => {
  const h = await harness();
  h.state.insert = async args => { h.state.deal.meetingOwnerType = "guest_meet"; return { data: ready(args.requestBody.id) }; };
  const response = await h.post({});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "MEET_CHANGED");
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.deal.meetingOwnerType, "guest_meet");
  assert.equal(h.state.deal.meetUrl, null);
});

// T02 受入条件3 / T11（2026-09-30 クラウド確認 GM-06）：Google カレンダー側で予定が削除されると、
// events.patch は 404/410 ではなく 200・status "cancelled" を返す。再試行しても同じ予定は戻らないので、
// 404/410 と同じく新しい予定・Meet を作り直す（参加者・招待は付けない）。
const cancelled = id => ({ id, status: "cancelled", hangoutLink: "https://meet.google.com/old-link-xyz" });

test("an event deleted on Google's side (patch returns cancelled) is replaced like a missing one", async () => {
  const h = await harness();
  h.state.patch = async args => ({ data: args.eventId === "deleted" ? cancelled(args.eventId) : ready(args.eventId) });
  const result = await h.meet.upsertMeetEvent({ ...input, eventId: "deleted" });
  assert.equal(result.status, "ready");
  assert.notEqual(result.eventId, "deleted");
  assert.equal(h.state.inserts.length, 1);
  // No second conference-retry patch is sent to the deleted event, and nobody is invited.
  assert.equal(h.state.patches.length, 1);
  const { requestBody } = h.state.inserts[0];
  assert.equal(requestBody.attendees, undefined);
  assert.equal(h.state.inserts[0].sendUpdates, undefined);
  // A retry of the same sync (e.g. the response was lost) reuses the same replacement ID.
  const again = await h.meet.upsertMeetEvent({ ...input, eventId: "deleted" });
  assert.equal(h.state.inserts[1].requestBody.id, requestBody.id);
  assert.equal(again.eventId, result.eventId);
});

test("sync API recovers a deleted event with a new URL and resets the old Meet artifact state", async () => {
  const h = await harness(); h.mocks.env.FEATURE_MEET_AUTO_RECORD = "1";
  Object.assign(h.state.deal, { meetEventId: "deleted", meetUrl: "https://meet.google.com/old-link-xyz" });
  h.state.patch = async args => ({ data: args.eventId === "deleted" ? cancelled(args.eventId) : ready(args.eventId) });
  h.state.insert = async args => ({ data: { id: args.requestBody.id, hangoutLink: "https://meet.google.com/new-link-abc" } });
  const response = await h.post({});
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deal.meetUrl, "https://meet.google.com/new-link-abc");
  assert.notEqual(json.deal.meetEventId, "deleted");
  assert.equal(h.state.deal.meetSpaceName, null);
  assert.equal(h.state.deal.meetArtifactAttempts, 0);
  assert.equal(h.state.artifacts, 1);
});

test("a cancelled event that cannot be replaced automatically points the user to 再発行", async () => {
  const h = await harness();
  Object.assign(h.state.deal, { meetEventId: "deleted", meetUrl: "https://meet.google.com/old-link-xyz" });
  // The replacement ID is already taken by an event that was deleted too (409 → it is cancelled).
  h.state.patch = async args => ({ data: cancelled(args.eventId) });
  h.state.insert = async () => { throw { response: { status: 409 } }; };
  const response = await h.post({});
  assert.equal(response.status, 502);
  const json = await response.json();
  assert.equal(json.code, "GOOGLE_MEET_OPERATION_FAILED");
  assert.match(json.message, /削除されています/);
  assert.match(json.message, /「再発行」/);
  assert.doesNotMatch(json.message, /再試行してください/);
  assert.equal(h.state.writes, 0);
  // 再発行 (forceRecreate) uses a different event ID and succeeds.
  h.state.insert = async args => ({ data: ready(args.requestBody.id) });
  const reissue = await h.post({ forceRecreate: true, expectedEventId: "deleted" });
  assert.equal(reissue.status, 200);
  assert.notEqual(h.state.deal.meetEventId, "deleted");
});
