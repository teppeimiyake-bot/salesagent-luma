import { strict as assert } from "node:assert";
import type { DealForBant } from "../src/lib/ai/summarize-bant";

process.env.DATABASE_URL ??= "postgresql://t06_check:t06_check@localhost:5432/t06_check";

const { buildBantAggregationPrompt, mergeDealBant } = await import("../src/lib/ai/summarize-bant");

const existingBant = {
  budget: "既存予算",
  authority: "既存の決裁構造",
  need: "既存ニーズ",
  timeline: "既存時期",
  summary: "既存サマリ",
  confidence: 66,
  updatedBy: "manual",
  manualFields: {
    budget: false,
    authority: true,
    need: false,
    timeline: false,
  },
  items: {
    budget: {
      value: "既存予算",
      status: "confirmed",
      source_meeting_id: "existing-budget",
      quote: "既存予算の根拠",
    },
    authority: {
      value: "既存 items.authority",
      status: "confirmed",
      source_meeting_id: "existing-authority",
      quote: "既存決裁構造の根拠",
    },
    need: {
      value: "既存ニーズ",
      status: "confirmed",
      source_meeting_id: "existing-need",
      quote: "既存ニーズの根拠",
    },
    timeline: {
      value: "既存時期",
      status: "estimated",
      source_meeting_id: "existing-timeline",
      quote: "既存時期の根拠",
    },
  },
  industry: "送らない業界",
  fiscalMonth: 3,
  meetingNotes: "SECRET_MEETING_NOTES_BODY",
  isNG: true,
  notionPageUrl: "https://example.com/notion-secret",
};

const generatedBant = {
  budget: "AI予算",
  authority: "AI決裁構造",
  need: "AIニーズ",
  timeline: "AI時期",
  summary: "AIサマリ",
  confidence: 88,
  items: {
    budget: {
      value: "AI予算",
      status: "estimated",
      source_meeting_id: "ai-budget",
      quote: "AI予算の根拠",
    },
    authority: {
      value: "AI決裁構造",
      status: "estimated",
      source_meeting_id: "ai-authority",
      quote: "AI決裁構造の根拠",
    },
    need: {
      value: "AIニーズ",
      status: "estimated",
      source_meeting_id: "ai-need",
      quote: "AIニーズの根拠",
    },
    timeline: {
      value: "AI時期",
      status: "estimated",
      source_meeting_id: "ai-timeline",
      quote: "AI時期の根拠",
    },
  },
};

const merged = mergeDealBant(existingBant, generatedBant, "auto");

assert.equal(merged.industry, existingBant.industry, "A: industry should remain after merge");
assert.equal(merged.fiscalMonth, existingBant.fiscalMonth, "A: fiscalMonth should remain after merge");
assert.equal(merged.meetingNotes, existingBant.meetingNotes, "A: meetingNotes should remain after merge");
assert.equal(merged.isNG, existingBant.isNG, "A: isNG should remain after merge");

assert.equal(merged.authority, existingBant.authority, "B: manual authority should not be overwritten");
assert.deepEqual(
  merged.items.authority,
  existingBant.items.authority,
  "B: manual items.authority should not be overwritten",
);
assert.deepEqual(
  merged.aiSuggestion?.authority,
  generatedBant.items.authority,
  "B: AI authority should be stored in aiSuggestion.authority",
);

const meetings = Array.from({ length: 10 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return {
    id: `meeting-${n}`,
    title: `商談 ${n}`,
    meetingDate: new Date(`2026-08-${14 - index}T00:00:00.000Z`),
    minutes: `議事録 ${n}`,
    minutesJson: null,
    transcript: null,
    bantBudget: `予算 ${n}`,
    bantAuthority: `決裁 ${n}`,
    bantNeed: `ニーズ ${n}`,
    bantTimeline: `時期 ${n}`,
  };
});

const deal: DealForBant = {
  id: "deal-t06",
  title: "T06検証商談",
  status: "active",
  bant: existingBant,
  bantUpdatedAt: null,
  company: { name: "T06検証会社", industry: "PROMPT_INDUSTRY_SHOULD_NOT_APPEAR" },
  products: [],
  meetings,
};

const prompt = buildBantAggregationPrompt(deal).user;

for (let i = 1; i <= 5; i += 1) {
  assert.match(prompt, new RegExp(`meeting_id: meeting-${String(i).padStart(2, "0")}`), "C: recent meeting missing");
}
for (let i = 6; i <= 10; i += 1) {
  assert.doesNotMatch(
    prompt,
    new RegExp(`meeting_id: meeting-${String(i).padStart(2, "0")}`),
    "C: old meeting should not be included",
  );
}
assert.equal((prompt.match(/^meeting_id:/gm) ?? []).length, 5, "C: prompt should include exactly 5 meeting_id lines");

assert.doesNotMatch(prompt, /SECRET_MEETING_NOTES_BODY/, "D: meetingNotes body should not be included");
assert.doesNotMatch(prompt, /meetingNotes/, "D: meetingNotes key should not be included");
assert.doesNotMatch(prompt, /PROMPT_INDUSTRY_SHOULD_NOT_APPEAR/, "D: industry should not be included");

console.log("check:t06 OK");
