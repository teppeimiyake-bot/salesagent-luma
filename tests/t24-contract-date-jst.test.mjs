// T24: 受注への変更で自動設定する受注計上日は、画面の「本日でセット」と同じく日本時間の今日（UTC 0:00）で保存する。
// 日付だけの値の形（その暦日の UTC 0:00）にそろえ、表示・KPI（どちらも日本時間の暦日で読む）と同じ日を指すようにする。DB・外部通信は模擬する。
import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

// 2026-10-01 02:00 JST: the UTC calendar day is still 09-30, so a UTC-day implementation would fail.
const FIXED_NOW = Date.parse("2026-09-30T17:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return FIXED_NOW; }
}
const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getCurrentPermission=async()=>'user';export const hasPermission=p=>p==='user';export const getSession=async()=>({userId:'u'});",
  "@/lib/deal-aggregations": "export const probabilityToYomi=()=>null;export const YOMI_TO_PROBABILITY={};",
  "@/lib/yomi-status": "export const stripYomiPrefix=s=>s;export const isWonYomi=s=>s==='受注';",
  "@/lib/contract-generate": "export const generateContractDraft=async()=>({ok:false,reason:'unused'});export const isAPlusYomi=()=>false;",
  "@/lib/payment-sync": "export const syncWonProductToPayments=async()=>null;",
  // 先方の受注時の PM 同期と、入金同期を操作中の会社で動かす処理。このテストでは計上日だけを見る。
  "@/lib/pm-sync": "export const syncWonProductToPm=async()=>null;",
  "@/lib/tenant-context": "export const getRequestTenant=async()=>null;export const runWithTenant=(_t,fn)=>fn();",
};
const allowed = entry => [entry, "src/lib/meeting-datetime.ts"];

function setup(contractDate = null) {
  const m = { writes: [], deal: { id: "deal", deletedAt: null, contractDate } };
  m.prisma = {
    deal: {
      findUnique: async () => ({ ...m.deal }),
      update: async ({ data }) => { m.writes.push(data); Object.assign(m.deal, data); return m.deal; },
    },
    dealProduct: {
      findUnique: async () => ({ yomiStatus: "Aヨミ" }),
      update: async ({ data }) => ({ id: "p", dealId: "deal", ...data }),
      create: async ({ data }) => ({ id: "p", ...data }),
    },
  };
  return m;
}

function assertJstDay(value) {
  assert.ok(value instanceof RealDate);
  assert.equal(value.toISOString(), "2026-10-01T00:00:00.000Z", "UTC 0:00 of the JST calendar day, like 本日でセット");
}

test("T24 winning a product sets the contract date to today in JST (PATCH and POST); an existing date is kept", async (t) => {
  // offlineModule hands the global Date to the bundled route, so the route sees the fixed clock.
  globalThis.Date = FixedDate;
  t.after(() => { globalThis.Date = RealDate; });
  for (const [entry, call] of [
    ["src/app/api/deal-products/[id]/route.ts", route => route.PATCH(new Request("http://offline.invalid", { method: "PATCH", body: JSON.stringify({ yomiStatus: "受注" }) }), { params: Promise.resolve({ id: "p" }) })],
    ["src/app/api/deals/[id]/products/route.ts", route => route.POST(new Request("http://offline.invalid", { method: "POST", body: JSON.stringify({ productName: "架空商材", yomiStatus: "受注" }) }), { params: Promise.resolve({ id: "deal" }) })],
  ]) {
    const m = setup();
    const route = await offlineModule(entry, m, boundaries, allowed(entry));
    const response = await call(route);
    assert.ok(response.status < 300, `${entry}: ${response.status}`);
    assert.equal(m.writes.length, 1);
    assertJstDay(m.writes[0].contractDate);

    const kept = setup(new Date("2026-08-01T00:00:00.000Z"));
    await call(await offlineModule(entry, kept, boundaries, allowed(entry)));
    assert.equal(kept.writes.length, 0, "a contract date set by the user is not overwritten");
  }
});
