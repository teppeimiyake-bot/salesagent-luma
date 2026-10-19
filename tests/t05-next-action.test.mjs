import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
import { LONG_ANALYSIS_PURE_MODULES } from "./helpers/long-analysis-modules.mjs";

const entry = "src/lib/meetings/analysis.ts";
const allowed = [entry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES];
const suggestion = "未確認事項を確認する方法を社内で整理する";
const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/ai/pipeline": "export const runPipeline=(...args)=>mocks.pipeline(...args);",
  "@/lib/meetings/processing": "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBING:'transcribing',ANALYZING:'analyzing',ERROR:'error',COMPLETED:'completed'};",
  "@/lib/feature-flags": "export const isAutoBantFeatureEnabled=()=>true;",
  "@/lib/ai/summarize-bant": "export const scheduleDealBantSummary=async()=>{mocks.bantCalls++};",
  "@/lib/meetings/status-payload": "export const isAnalysisStalled=()=>false;",
};

function setup(nextAction = null, nextActionAt = null) {
  const deal = { id: "deal", title: "架空商談", company: { name: "架空企業" }, products: [],
    nextAction, nextActionAt, updatedAt: new Date("2026-09-23T00:00:00Z") };
  const row = { id: "meeting", dealId: deal.id, deal, minutes: null,
    transcript: "顧客：次回日程は未定です。社内で確認してから連絡します。", processingStatus: "transcribed" };
  const mocks = { deal, row, bantCalls: 0, conditionalWrites: 0, unconditionalWrites: 0 };
  const matches = (target, where) => Object.entries(where).every(([key, value]) =>
    value instanceof Date ? target[key] instanceof Date && target[key].getTime() === value.getTime() : target[key] === value);
  mocks.editDeal = (data) => {
    Object.assign(deal, data);
    deal.updatedAt = new Date(deal.updatedAt.getTime() + 1000);
  };
  mocks.prisma = {
    meeting: {
      findUnique: async () => structuredClone(row),
      update: async ({ data }) => Object.assign(row, data),
      updateMany: async ({ where, data }) => {
        if (!matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    deal: {
      update: async ({ data }) => {
        mocks.unconditionalWrites++;
        mocks.editDeal(data);
        return structuredClone(deal);
      },
      updateMany: async ({ where, data }) => {
        mocks.conditionalWrites++;
        if (!matches(deal, where)) return { count: 0 };
        mocks.editDeal(data);
        return { count: 1 };
      },
    },
    aiLog: { findMany: async () => [], create: async () => ({}) },
  };
  mocks.pipeline = async () => ({
    meetingMinutes: { markdown: "顧客は確認後に連絡する。期限は未確認。", json: {}, usedFallback: false },
    analysis: { issues: [], bant: { budget: "未確認", authority: "未確認", need: "未確認", timeline: "未確認" } },
    topSales: { real_intent: "未確認", winning_scenario: "未確認事項を整理する" },
    nextActions: { next_actions: [{ action: suggestion }] },
    structured: {}, strategy: {}, scores: {}, trace: [], improved: false, fallback: false,
  });
  return mocks;
}

async function analyze(mocks) {
  const lib = await offlineModule(entry, mocks, boundaries, allowed);
  assert.equal((await lib.runMeetingAnalysis("meeting")).ok, true);
  assert.equal(mocks.row.processingStatus, "completed");
  assert.equal(mocks.row.nextActions.next_actions[0].action, suggestion);
  assert.equal(mocks.bantCalls, 1);
}

test("T05 initializes an empty next action without inventing a due date", async () => {
  const mocks = setup();
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, suggestion);
  assert.equal(mocks.deal.nextActionAt, null);
  assert.equal(mocks.conditionalWrites, 1);
});

test("T05 treats a legacy blank action as empty only when its due date is unset", async () => {
  const mocks = setup("  ");
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, suggestion);
  assert.equal(mocks.deal.nextActionAt, null);
});

test("T05 preserves a saved next action with or without a due date", async () => {
  for (const date of [null, new Date("2026-08-13T00:00:00Z")]) {
    const mocks = setup("担当者が保存した次の対応", date);
    await analyze(mocks);
    assert.equal(mocks.deal.nextAction, "担当者が保存した次の対応");
    assert.deepEqual(mocks.deal.nextActionAt, date);
    assert.equal(mocks.conditionalWrites, 0);
  }
});

test("T05 does not combine a new AI action with an existing overdue date", async () => {
  const date = new Date("2026-08-13T00:00:00Z");
  const mocks = setup(null, date);
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, null);
  assert.deepEqual(mocks.deal.nextActionAt, date);
  assert.equal(mocks.conditionalWrites, 0);
});

test("T05 preserves an action entered while AI is generating", async () => {
  const mocks = setup();
  const pipeline = mocks.pipeline;
  mocks.pipeline = async () => {
    mocks.editDeal({ nextAction: "処理中に担当者が入力した対応" });
    return pipeline();
  };
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, "処理中に担当者が入力した対応");
  assert.equal(mocks.deal.nextActionAt, null);
});

test("T05 preserves a due date selected while AI is generating", async () => {
  const mocks = setup();
  const date = new Date("2026-09-30T00:00:00Z");
  const pipeline = mocks.pipeline;
  mocks.pipeline = async () => {
    mocks.editDeal({ nextActionAt: date });
    return pipeline();
  };
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, null);
  assert.deepEqual(mocks.deal.nextActionAt, date);
});

test("T05 preserves an intentional clear even when both fields end empty", async () => {
  const mocks = setup();
  const pipeline = mocks.pipeline;
  mocks.pipeline = async () => {
    mocks.editDeal({ nextAction: "一度入力した対応" });
    mocks.editDeal({ nextAction: null });
    return pipeline();
  };
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, null);
  assert.equal(mocks.deal.nextActionAt, null);
});

test("T05 does not refill a pre-existing action cleared during generation", async () => {
  const mocks = setup("以前に保存した対応");
  const pipeline = mocks.pipeline;
  mocks.pipeline = async () => {
    mocks.editDeal({ nextAction: null });
    return pipeline();
  };
  await analyze(mocks);
  assert.equal(mocks.deal.nextAction, null);
  assert.equal(mocks.conditionalWrites, 0);
});
