import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleT01Sources, loadSource, routeRequest } from "../scripts/lib/t01-development.mjs";
import datetime from "../src/lib/meeting-datetime.ts";
const { toJstDateTimeInput, jstDateTimeInputToIso, meetingScheduledAtFromStart } = datetime;

const compiled = await bundleT01Sources();
const fixture = { deal: "demo" };
const start = "2026-09-21T14:30:00.000Z";
const end = "2026-09-21T15:30:00.000Z";

function harness() {
  const state = { deal: { id: "demo", meetingStartAt: null, meetingEndAt: null,
    meetingScheduledAt: null, updatedAt: new Date("2026-01-01T00:00:00Z"), deletedAt: null,
    company: { deletedAt: null }, meetings: [] }, writes: 0, conflict: false };
  const dependencies = { permission: "user", generated: { DealStatus: { LEAD: "LEAD" } }, prisma: {
    deal: {
      findUnique: async () => structuredClone(state.deal),
      update: async ({ data, where }) => {
        if (state.conflict || where.updatedAt?.getTime() !== state.deal.updatedAt.getTime() && where.updatedAt) {
          throw Object.assign(Error("Concurrent update"), { code: "P2025" });
        }
        state.writes++;
        Object.assign(state.deal, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
        return structuredClone(state.deal);
      },
    },
  } };
  const route = loadSource(compiled, "route", dependencies);
  return { state, dependencies, patch: body => routeRequest(route, fixture, body) };
}

test("JST midnight and cross-day conversion do not depend on machine timezone", () => {
  assert.equal(toJstDateTimeInput(start), "2026-09-21T23:30");
  assert.equal(toJstDateTimeInput(end), "2026-09-22T00:30");
  assert.equal(jstDateTimeInputToIso("2026-09-22T00:30"), end);
  assert.equal(meetingScheduledAtFromStart(start).toISOString(), "2026-09-20T15:00:00.000Z");
  assert.equal(toJstDateTimeInput(null), "");
});

test("register, reschedule and clear synchronize the legacy date", async () => {
  const { patch, state } = harness();
  assert.equal((await patch({ meetingStartAt: start, meetingEndAt: end })).status, 200);
  assert.equal(state.deal.meetingScheduledAt.toISOString(), "2026-09-20T15:00:00.000Z");
  assert.equal((await patch({ meetingStartAt: "2026-09-22T01:00:00Z", meetingEndAt: "2026-09-22T02:00:00Z" })).status, 200);
  assert.equal(state.deal.meetingScheduledAt.toISOString(), "2026-09-21T15:00:00.000Z");
  assert.equal((await patch({ meetingStartAt: null, meetingEndAt: null })).status, 200);
  assert.equal(state.deal.meetingScheduledAt, null);
});

test("invalid full and partial ranges never write", async () => {
  const { patch, state } = harness();
  assert.equal((await patch({ meetingStartAt: end, meetingEndAt: start })).status, 400);
  assert.equal(state.writes, 0);
  await patch({ meetingStartAt: start, meetingEndAt: end });
  for (const payload of [{ meetingEndAt: "2026-09-20T00:00:00Z" },
    { meetingStartAt: "2026-09-25T00:00:00Z" }, { meetingStartAt: null }]) {
    assert.equal((await patch(payload)).status, 400);
  }
  assert.equal(state.writes, 1);
});

test("end-only data requires a start; start-only and equal times remain supported", async () => {
  const { patch, state } = harness();
  assert.equal((await patch({ meetingEndAt: end })).status, 400);
  assert.equal((await patch({ meetingStartAt: start })).status, 200);
  assert.equal(state.deal.meetingEndAt, null);
  assert.equal((await patch({ meetingEndAt: start })).status, 200);
});

test("date-only and unrelated patches preserve timestamps", async () => {
  const { patch, state } = harness();
  await patch({ meetingStartAt: start, meetingEndAt: end });
  assert.equal((await patch({ meetingScheduledAt: "2026-09-25T15:00:00Z" })).status, 200);
  assert.equal((await patch({ nextAction: "デモ確認" })).status, 200);
  assert.equal(state.deal.meetingStartAt.toISOString(), start);
  assert.equal(state.deal.meetingEndAt.toISOString(), end);
});

test("malformed dates are rejected before writing", async () => {
  const { patch, state } = harness();
  for (const value of ["wrong", "2026-02-30T01:00:00Z", "2026-09-21T25:00:00Z"]) {
    assert.equal((await patch({ meetingStartAt: value })).status, 400);
  }
  assert.equal(state.writes, 0);
});

test("viewer and unauthenticated schedule edits are rejected", async () => {
  const { patch, state, dependencies } = harness();
  for (const permission of ["viewer", null]) {
    dependencies.permission = permission;
    assert.equal((await patch({ meetingStartAt: start })).status, 403);
  }
  assert.equal(state.writes, 0);
});

test("missing or deleted records cannot have their schedule edited", async () => {
  const { patch, state } = harness();
  state.deal.company.deletedAt = new Date();
  assert.equal((await patch({ meetingStartAt: start })).status, 410);
  state.deal.company.deletedAt = null;
  state.deal.deletedAt = new Date();
  assert.equal((await patch({ meetingStartAt: start })).status, 410);
  state.deal = null;
  assert.equal((await patch({ meetingStartAt: start })).status, 404);
  assert.equal(state.writes, 0);
});

test("a concurrent update returns 409 without overwriting", async () => {
  const { patch, state } = harness();
  state.conflict = true;
  assert.equal((await patch({ meetingStartAt: start, meetingEndAt: end })).status, 409);
  assert.equal(state.writes, 0);
});
