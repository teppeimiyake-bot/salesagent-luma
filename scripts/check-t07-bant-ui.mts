import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveBantCardView, repairUtf8Mojibake } = require("../src/components/deals/bant-summary-utils.ts") as typeof import("../src/components/deals/bant-summary-utils");

const meetings = [
  { id: "meeting-1", title: "初回商談", meetingDate: "2026-07-25T00:00:00.000Z" },
  { id: "meeting-2", title: "第2回商談", meetingDate: "2026-08-02T00:00:00.000Z" },
];

const manualOldBudget = resolveBantCardView(
  {
    budget: "1",
    manualFields: { budget: true },
  },
  "budget",
  meetings,
);
assert.equal(manualOldBudget.value, "1");
assert.equal(manualOldBudget.status, "unreviewed");
assert.equal(manualOldBudget.isManual, true);
assert.equal(manualOldBudget.source, undefined);

const historicalManualBudget = resolveBantCardView(
  {
    budget: "予算80万円を想定。社内承認はまだ取れていない。",
    manualFields: { budget: true },
    items: { budget: { status: "confirmed" } },
  },
  "budget",
);
assert.equal(historicalManualBudget.status, "unreviewed");
assert.equal(resolveBantCardView({ timeline: "未定", manualFields: { timeline: true } }, "timeline").status, "unknown");

const sourcedAuthority = resolveBantCardView(
  {
    items: {
      authority: {
        value: "決裁者は社長。窓口は人事部長",
        status: "confirmed",
        source_meeting_id: "meeting-2",
        quote: "最後は社長の判断になります",
      },
    },
    aiSuggestion: {
      authority: {
        value: "役員会の確認も必要",
        status: "estimated",
      },
    },
  },
  "authority",
  meetings,
);
assert.equal(sourcedAuthority.value, "決裁者は社長。窓口は人事部長");
assert.equal(sourcedAuthority.status, "confirmed");
assert.equal(sourcedAuthority.source?.href, "#meeting-meeting-2");
assert.match(sourcedAuthority.source?.label ?? "", /第2回商談/);
assert.equal(sourcedAuthority.source?.quote, "最後は社長の判断になります");
assert.equal(sourcedAuthority.aiSuggestion, "役員会の確認も必要");

const unknownNeed = resolveBantCardView({ need: "未確定: ニーズ課題を確認する必要あり" }, "need", meetings);
assert.equal(unknownNeed.status, "unknown");

const garbledSample = Buffer.from("サンプル", "utf8").toString("latin1");
assert.equal(repairUtf8Mojibake(garbledSample), "サンプル");
assert.equal(repairUtf8Mojibake("人事部長"), "人事部長");

console.log("check:t07-bant-ui OK");
