// T24: 受注計上日は「日付だけの値」として保存（その暦日の UTC 0:00）し、KPI では日本時間の暦日で月・週・期間へ振り分ける。
// 保存形式の違う既存データ（UTC 0:00・日本時間 0:00・受注した時刻そのもの）も同じ日・同じ月に数える。DB は模擬する。
import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
import calendarDate from "../src/lib/calendar-date.ts";
import config from "../src/lib/config.ts";

// Run as on Cloud Run (UTC): helpers that fell back to local-time getters would pass on a JST machine but fail here.
process.env.TZ = "UTC";

const { jstYmd, addDaysYmd, dateOnlyInputToIso } = calendarDate;

// The same business day, 2026-10-01, as stored by the three conventions found in the data.
const OCT_1 = [
  "2026-10-01T00:00:00.000Z", // date-only value: 商談画面の日付欄・本日でセット・受注時の自動設定・KPI 画面の編集欄（今回から）
  "2026-09-30T15:00:00.000Z", // JST 0:00: KPI 画面の編集欄（変更前）
  "2026-09-30T17:00:00.000Z", // the instant a product was won at 02:00 JST (automatic setting before the fix)
].map(iso => new Date(iso));

test("T24 calendar dates: the three stored forms of one business day are the same JST day; input is saved as that day's UTC 0:00", () => {
  for (const date of OCT_1) assert.equal(jstYmd(date), "2026-10-01");
  assert.equal(jstYmd(new Date("2026-09-30T14:59:59.999Z")), "2026-09-30");
  assert.equal(addDaysYmd("2026-10-01", -6), "2026-09-25");
  assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
  assert.equal(dateOnlyInputToIso("2026-10-01"), "2026-10-01T00:00:00.000Z");
  assert.equal(dateOnlyInputToIso(" 2026-10-01 "), "2026-10-01T00:00:00.000Z");
  for (const bad of ["2026-02-30", "2026-13-01", "2026/10/01", ""]) assert.equal(dateOnlyInputToIso(bad), null, bad);
});

test("T24 fiscal helpers use the JST calendar: 00:30 JST on June 1 is already the new fiscal year and month", () => {
  const juneFirstJst = new Date("2026-05-31T15:30:00.000Z"); // 2026-06-01 00:30 JST
  assert.equal(config.getFiscalYear(6, juneFirstJst), 2026);
  assert.equal(config.getFiscalMonthIndex(6, juneFirstJst), 0);
  assert.equal(config.getFiscalQuarter(6, juneFirstJst), 1);
  assert.equal(config.getFiscalYear(6, new Date("2026-05-31T14:59:00.000Z")), 2025, "still May 31 in JST");
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["2026-09-30T17:00:00.000Z"])); } static now() { return RealDate.parse("2026-09-30T17:00:00.000Z"); } };
  try {
    assert.equal(config.currentMonthPeriod(), "2026-10");
  } finally {
    globalThis.Date = RealDate;
  }
});

// product / recurringBillings / productionProject は先方の売上計上（revenue-recognition）が読む項目。スポット商材（映像）として計上月に全額。
const productWon = [{ id: "p1", productId: null, productName: "採用動画", planName: null, amount: 1_000_000, yomiStatus: "受注", probability: 100,
  product: { name: "採用動画", category: "映像" }, recurringBillings: [], productionProject: null }];
function wonDeal(id, contractDate, extra = {}) {
  return { id, contractDate, appointmentDate: null, bantUpdatedAt: null, createdAt: contractDate ?? new Date("2026-07-01T00:00:00Z"), company: { name: `架空企業${id}` }, products: productWon, ...extra };
}

async function loadQueries(m) {
  const entry = "src/lib/queries.ts";
  return offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/tenant-context": "export const getFiscalStartMonth=async()=>6;export const currentTenantId=()=>\"t-test\";",
    "@/lib/tenant-users": "export const listCurrentTenantUsers=async()=>[];",
    "@prisma/client": "export const DealStatus={};export const TaskStatus={};",
    "@/lib/deal-status": "export const isExcludedFromNextAction=()=>false;",
    "@/lib/deal-status-server": "export const excludeNGDealsWhere=()=>({});export const excludeDoneAndNGDealsWhere=()=>({});",
    "@/lib/kpi-rollup": "export const buildKpiRollup=()=>{throw Error('unused')};",
    // 先方の売上計上（SNS 月次按分）が使うリクエスト単位のメモ化。テストでは素通しにする。
    react: "export const cache=(fn)=>fn;",
  }, [entry, "src/lib/config.ts", "src/lib/calendar-date.ts", "src/lib/revenue-recognition.ts", "src/lib/product-categories.ts", "src/lib/deal-aggregations.ts", "src/lib/yomi-status.ts"]);
}

// The mock applies the date-range filters of the query, so the DB range itself is tested too.
const inDateRange = (value, cond) => !cond || (!!value && (!cond.gte || value >= cond.gte) && (!cond.lte || value <= cond.lte));
// Date fields (a range, or null for "not set") and OR alternatives, as the queries use them.
const DATE_FIELDS = ["contractDate", "appointmentDate", "bantUpdatedAt", "createdAt"];
const matchesWhere = (d, where) => DATE_FIELDS.every((k) => !(k in where) || (where[k] === null ? d[k] == null : inDateRange(d[k], where[k])))
  && (!where.OR || where.OR.some((alt) => matchesWhere(d, alt)))
  // products: { some: { OR: [{ yomiStatus: { contains } }] } } — the won-product filter the queries send to the DB.
  && (!where.products?.some?.OR || d.products.some((p) => where.products.some.OR.some((c) => p.yomiStatus.includes(c.yomiStatus.contains))));
function setup(deals, tasks = []) {
  const m = { findManyArgs: [] };
  m.prisma = {
    deal: { findMany: async (args) => {
      m.findManyArgs.push(args);
      return deals.filter((d) => matchesWhere(d, args?.where ?? {}));
    } },
    task: { findMany: async () => tasks },
    // 先方の MS 送付実績（KPI の月次セル）。このテストでは実績なし。
    msWeeklyEntry: { findMany: async () => [] },
    goal: { findMany: async () => [], findFirst: async () => null, findUnique: async () => null },
  };
  return m;
}

test("T24 KPI monthly bases: a deal booked on Oct 1 counts in October whichever way the date was stored", async () => {
  const deals = OCT_1.map((date, i) => wonDeal(`d${i}`, date));
  deals.push(wonDeal("oct31", new Date("2026-10-30T15:00:00.000Z"))); // 2026-10-31 00:00 JST → October (month end)
  deals.push(wonDeal("late", new Date("2026-10-31T15:30:00.000Z"))); // 2026-11-01 00:30 JST → November
  deals.push(wonDeal("fy-first", new Date("2026-05-31T15:00:00.000Z"))); // 2026-06-01 00:00 JST → first month of FY2026
  deals.push(wonDeal("fy-last", new Date("2027-05-31T14:00:00.000Z"))); // 2027-05-31 23:00 JST → last month of FY2026
  deals.push(wonDeal("next-fy", new Date("2027-05-31T15:00:00.000Z"))); // 2027-06-01 00:00 JST → FY2027, not counted
  const m = setup(deals);
  const lib = await loadQueries(m);
  const bases = await lib.getMonthlyKpiBases(2026);
  // FY2026 starts in June: index 0 = June, 4 = October, 5 = November, 11 = May 2027.
  assert.equal(bases[4].wonCount, 4);
  assert.equal(bases[4].revenue, 4_000_000);
  assert.equal(bases[5].wonCount, 1);
  assert.equal(bases[3].wonCount, 0, "nothing leaks into September");
  assert.equal(bases[0].wonCount, 1, "a JST-0:00 value on the first day of the FY is fetched and counted");
  assert.equal(bases[11].wonCount, 1, "the last day of the FY is counted");
  assert.equal(bases.reduce((sum, base) => sum + base.wonCount, 0), 7, "the next FY's first day is not counted");
  // New deals are counted by their JST creation month (created at the same instants here).
  assert.deepEqual([bases[0].dealCount, bases[4].dealCount, bases[5].dealCount, bases[11].dealCount], [1, 4, 1, 1]);
  // The DB range starts 9 hours early so a JST-0:00 value on the first day of the fiscal year is fetched.
  const where = m.findManyArgs[0].where.OR[0].contractDate;
  assert.ok(where.gte.getTime() <= Date.parse("2026-05-31T15:00:00.000Z"), where.gte.toISOString());
  // 商談数は先方の仕様で初回商談日（未設定のみ作成日）起算。どちらの範囲も9時間前から取る。
  const [byAppointment, byCreated] = m.findManyArgs[1].where.OR;
  assert.ok(byAppointment.appointmentDate.gte.getTime() <= Date.parse("2026-05-31T15:00:00.000Z"), "the new-deal query starts 9 hours early too");
  assert.ok(byCreated.createdAt.gte.getTime() <= Date.parse("2026-05-31T15:00:00.000Z"), "the new-deal query starts 9 hours early too");
});

test("T24 KPI goal progress and monthly cards use the same JST day", async () => {
  const deals = OCT_1.map((date, i) => wonDeal(`d${i}`, date));
  deals.push(wonDeal("fallback", null, { appointmentDate: new Date("2026-09-30T15:00:00.000Z") }));
  deals.push(wonDeal("oct31", new Date("2026-10-30T15:00:00.000Z"))); // the last day of the month (JST 0:00 form)
  const m = setup(deals);
  const lib = await loadQueries(m);
  assert.equal((await lib.getGoalProgress("2026-10")).wonAmount, 5_000_000);
  assert.equal((await lib.getGoalProgress("2026-09")).wonAmount, 0);
  assert.equal((await lib.getGoalProgress("FY2026-Q2")).wonAmount, 5_000_000, "FY2026 Q2 = Sep to Nov");
  const cards = await lib.getMonthlyWonDealsByPeriod(2026);
  assert.equal(cards["2026-10"].length, 5);
  assert.equal(cards["2026-09"].length, 0);
  // Objects built inside the offline bundle come from another realm, so compare them as JSON.
  assert.equal(JSON.stringify(cards["2026-10"].filter(card => card.contractDate).map(card => card.contractDate)), JSON.stringify(["2026-10-01", "2026-10-01", "2026-10-01", "2026-10-31"]));
  assert.equal(cards["2026-10"].find(card => card.dealId === "fallback").bookedDate, "2026-10-01");
  // The monthly bases count the same deals: a won deal without a contract date is booked on its meeting date.
  const bases = await lib.getMonthlyKpiBases(2026);
  assert.equal(bases[4].wonCount, 5);
  assert.equal(bases[4].revenue, 5_000_000);
  assert.equal(bases[3].wonCount, 0);
});

test("T24 KPI monthly bases book a won deal without a contract date on the meeting date, else the BANT update", async () => {
  const deals = [
    wonDeal("contract", new Date("2026-06-30T15:00:00.000Z")), // 2026-07-01 JST → July
    wonDeal("meeting", null, { appointmentDate: new Date("2026-07-14T15:00:00.000Z") }), // 2026-07-15 JST → July
    wonDeal("bant", null, { bantUpdatedAt: new Date("2026-08-01T03:00:00.000Z") }), // August
    wonDeal("undated", null), // no date at all: not placed in any month (as in the cards)
    // The contract date wins over an in-range meeting date: booked in FY2025, so not counted in FY2026.
    wonDeal("contract-first", new Date("2026-04-30T15:00:00.000Z"), { appointmentDate: new Date("2026-07-14T15:00:00.000Z") }),
    // Not won: not counted even when dated.
    wonDeal("open", new Date("2026-07-09T15:00:00.000Z"), { products: [{ ...productWon[0], yomiStatus: "提案中" }] }),
  ];
  const m = setup(deals);
  const lib = await loadQueries(m);
  const bases = await lib.getMonthlyKpiBases(2026);
  // FY2026 starts in June: index 1 = July, 2 = August.
  assert.deepEqual([bases[1].wonCount, bases[2].wonCount], [2, 1]);
  assert.equal(bases.reduce((sum, base) => sum + base.wonCount, 0), 3);
  assert.equal(bases[1].revenue, 2_000_000);
  const cards = await lib.getMonthlyWonDealsByPeriod(2026);
  assert.deepEqual([cards["2026-07"].length, cards["2026-08"].length], [bases[1].wonCount, bases[2].wonCount], "cards and bases agree");
  // Only won products are fetched for the bases, and every date field has its own range.
  const where = m.findManyArgs[0].where;
  assert.ok(where.products?.some, "won-product filter");
  assert.equal(JSON.stringify(where.OR.map((alt) => Object.keys(alt).sort())), JSON.stringify([["contractDate"], ["appointmentDate", "contractDate"], ["appointmentDate", "bantUpdatedAt", "contractDate"]]));
});

test("T24 KPI weekly chart: weeks are 7 JST days without gaps, and a deal won at 02:00 JST is in the current week", async (t) => {
  const RealDate = Date;
  const NOW = RealDate.parse("2026-09-30T17:00:00.000Z"); // 2026-10-01 02:00 JST
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } };
  t.after(() => { globalThis.Date = RealDate; });
  const deals = OCT_1.map((date, i) => wonDeal(`d${i}`, date));
  deals.push(wonDeal("week-first", new Date("2026-09-24T15:00:00.000Z"))); // 2026-09-25 JST: the current week's first day
  deals.push(wonDeal("prev-week-last", new Date("2026-09-23T15:00:00.000Z"))); // 2026-09-24 JST: the previous week's last day
  const tasks = [{ status: "DONE", completedAt: new Date("2026-09-30T16:00:00.000Z"), createdAt: new Date() }];
  const m = setup(deals, tasks);
  const lib = await loadQueries(m);
  const weeks = await lib.getKpiTimeseries();
  assert.equal(weeks.length, 12);
  const current = weeks.at(-1);
  assert.equal(current.label, "10/1");
  assert.equal(current.wonDeals, 4, "the three Oct 1 deals and the Sep 25 deal (the current week is Sep 25 to Oct 1)");
  assert.equal(current.tasksDone, 1);
  assert.equal(weeks.at(-2).label, "9/24");
  assert.equal(weeks.at(-2).wonDeals, 1);
  assert.equal(weeks.reduce((sum, week) => sum + week.wonDeals, 0), 5, "every deal is counted exactly once (no gap or overlap)");
});
