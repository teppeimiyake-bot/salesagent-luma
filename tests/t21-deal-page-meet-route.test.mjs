import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { offlineModule } from "./helpers/offline-module.mjs";

// T21/T24/T16 AC8：商談ページ（サーバーコンポーネント）が、会議種別と自動記録フラグに応じて
// どの記録導線を並べるかを確かめる。ページ本体と deal-phase / meeting-owner / recording-route /
// meeting-datetime だけを実物にし、DB・認証・子コンポーネントは印付きの空部品に差し替える。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "src/app/(app)/deals/[id]/page.tsx";
const OLD_OWN_MEET = "https://meet.google.com/old-own-meet";
const NOT_OWN_MEET = ["guest_meet", "zoom", "in_person", "unknown"];

const marked = (...names) => names.map((n) => `export const ${n}=Object.assign(()=>null,{stub:${JSON.stringify(n)}});`).join("");
const STUBS = {
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/navigation": "export const notFound=()=>{throw Error('NOT_FOUND')};export const redirect=(u)=>{throw Error('REDIRECT '+u)};",
  // 先方の「別の会社の商談リンクなら会社を切り替えてから開く」処理。テストでは会社が決まらない（切り替えない）。
  "@/lib/tenant-context": "export const getRequestTenant=async()=>null;",
  "next/link": "export default Object.assign(()=>null,{stub:'Link'});",
  "@/lib/db": "export const prisma=mocks.prisma;export const prismaUnscoped=mocks.prisma;",
  "@/lib/queries": "export const getSalesUsers=async()=>[];",
  "@/lib/auth": "export const getSession=async()=>({userId:'u1'});export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=(p,min)=>p==='admin'||(min==='user'&&p==='user');",
  "@/lib/feature-flags": "export const isMeetAutoRecordEnabled=()=>mocks.autoRecord;export const isMeetFeatureEnabled=()=>true;export const isPreparationV2Enabled=()=>false;export const isQuotePdfV2Enabled=()=>false;",
  "@/lib/yomi-status": "export const isWonYomi=()=>false;",
  "@/lib/pm-detail-data": "export const buildPmDetailDataForDeal=async()=>[];",
  "@/lib/product-categories": "export const categoryFromDealProduct=()=>null;",
  "@/lib/ai/bant-reconciliation": "export const reconcileBantFromMeetings=b=>b;",
  "@/lib/meetings/meet-ingest": "export const dealMeetStatus=async id=>{mocks.statusCalls.push(id);return {phase:'scheduled'}};",
  "@/components/layout/header": marked("Header"),
  "@/components/deals/upload-recording": marked("UploadRecording"),
  "@/components/deals/meeting-recorder": marked("MeetingRecorder"),
  "@/components/deals/meet-session-panel": marked("MeetSessionPanel"),
  "@/components/deals/meeting-owner-selector": marked("MeetingOwnerSelector"),
  "@/components/deals/meeting-recording-route": marked("MeetingRecordingRoute"),
  "@/components/deals/ai-panel": marked("AiPanel"),
  "@/components/deals/tasks-list": marked("TasksList"),
  "@/components/deals/deal-status": marked("DealStatusBar"),
  "@/components/deals/deal-products-panel": marked("DealProductsPanel"),
  "@/components/deals/preparation-panel": marked("PreparationPanel"),
  "@/components/deals/deal-documents": marked("DealDocuments"),
  "@/components/deals/deal-contracts": marked("DealContracts"),
  "@/components/deals/quote-builder": marked("QuoteBuilder"),
  "@/components/deals/contract-generator": marked("ContractGenerator"),
  "@/components/deals/meeting-history": marked("MeetingHistory"),
  "@/components/deals/bant-summary": marked("BantSummary"),
  "@/components/deals/deal-overview-panel": marked("DealOverviewPanel"),
  "@/components/dashboard/ai-chat": marked("AiChat"),
  "@/components/todos/new-task-dialog": marked("NewTaskDialog"),
  "@/components/ui/company-logo": marked("CompanyLogo"),
  "@/components/shared/delete-button": marked("DeleteButton"),
  "@/components/pm/pm-deal-panel": marked("PmDealPanel"),
  "@/components/deals/deal-industry-editor": marked("DealIndustryEditor"),
  "@/components/deals/deal-hero": marked("DealHero"),
  "@/components/deals/deal-detail-tabs": marked("DealDetailTabs"),
};
const REAL = new Set(["src/lib/deal-phase.ts", "src/lib/meeting-datetime.ts", "src/lib/meetings/meeting-owner.ts",
  "src/lib/meetings/recording-route.ts"].map((f) => path.join(ROOT, f)));

let bundle;
async function renderPage({ owner, autoRecord, meetUrl = OLD_OWN_MEET }) {
  bundle ??= build({
    absWorkingDir: ROOT, entryPoints: [PAGE], bundle: true, write: false, format: "cjs", platform: "neutral",
    jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "t21-page-stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
        if (a.path in STUBS) return { path: a.path, namespace: "stub" };
        const file = a.path.startsWith("@/") ? path.join(ROOT, "src", `${a.path.slice(2)}.ts`) : null;
        if (file && REAL.has(file)) return { path: file };
        return { errors: [{ text: `Unexpected dependency of ${PAGE}: ${a.path}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }));
    } }],
  }).then((result) => result.outputFiles[0].text);

  const deal = {
    id: "d1", title: "デモ商談", status: "LEAD", pipelineStage: null, nextAction: null, nextActionAt: null,
    appointmentDate: null, contractDate: null, expectedCloseDate: null,
    meetingStartAt: new Date("2026-09-30T05:00:00Z"), meetingEndAt: new Date("2026-09-30T06:00:00Z"),
    meetUrl, meetEventId: meetUrl ? "own-event" : null, meetingOwnerType: owner,
    leadSourceId: null, leadSource: null, leadSourceMemo: null, owner: null, bant: null, bantUpdatedAt: null,
    deletedAt: null, products: [], meetings: [], tasks: [],
    company: { id: "c1", name: "デモ株式会社", logoUrl: null, logoColor: null, industry: null, deletedAt: null },
  };
  const mocks = {
    autoRecord, statusCalls: [],
    prisma: {
      user: { findUnique: async () => ({ permission: "user" }) },
      deal: { findUnique: async () => deal },
      product: { findMany: async () => [] },
      planProposal: { findMany: async () => [] },
    },
  };
  const loaded = { exports: {} };
  vm.runInNewContext(await bundle, { module: loaded, exports: loaded.exports, mocks, Date });
  const tree = await loaded.exports.default({ params: Promise.resolve({ id: "d1" }), searchParams: Promise.resolve({}) });
  const all = elements(tree);
  const byStub = (name) => all.filter((el) => el.type?.stub === name);
  const byId = (id) => all.filter((el) => el.props?.id === id);
  return { all, byStub, byId, mocks };
}

/** JSX要素の木を、children だけでなくタブ定義・rail などのプロップも含めて平らにする。 */
function elements(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if ("type" in node && "props" in node) out.push(node);
  for (const value of Object.values("props" in node ? node.props ?? {} : node)) elements(value, out);
  return out;
}

// vm 内で作られたオブジェクトはプロトタイプが別なので、比較するときは {...} で写してから比べる。
const textOf = (el) => [el.props?.children].flat(Infinity).filter((c) => typeof c === "string").join("");

/** 商談記録タブの手動欄（見出しと説明）。MeetingRecorder／UploadRecording の上に出る文言。 */
function manualSectionOf(page) {
  const section = page.all.find((el) => el.props?.["data-testid"] === "manual-recording-section");
  const inner = elements(section?.props?.children);
  return { title: textOf(inner.find((el) => el.type === "h2")), description: textOf(inner.find((el) => el.type === "p")) };
}

const NON_OWN_MANUAL_TITLE = {
  guest_meet: "成果物を手動添付",
  zoom: "成果物を手動添付",
  in_person: "対面商談をマイク録音",
  unknown: "手動記録・添付",
};

test("T16 AC8 auto-recorded own Meet has no browser recorder; manual attachment remains", async () => {
  const page = await renderPage({ owner: "own_meet", autoRecord: true });
  assert.equal(page.byStub("MeetingRecorder").length, 0, "ブラウザ録音（タブ音声・停止して送信・バックアップ復元）");
  assert.equal(page.byId("section-record").length, 0);
  assert.equal(page.byStub("MeetSessionPanel").length, 1);
  assert.deepEqual(page.mocks.statusCalls, ["d1"]);
  assert.equal(page.byStub("UploadRecording").length, 1, "救済の手動添付は残す");
  assert.equal(page.byId("section-upload").length, 1);
  assert.deepEqual(manualSectionOf(page), {
    title: "必要な場合の手動添付",
    description: "自動取得できない成果物がある場合に、録画・音声・議事録・文字起こしを取り込みます。",
  });
  assert.doesNotMatch(page.all.map(textOf).join("\n"), /マイク録音/, "手動添付欄の説明にマイク録音を出さない");
  // ヒーローと記録ルート欄は同じ「自動記録」の案内
  const route = page.byStub("DealHero")[0].props.recordingRoute;
  assert.equal(page.byStub("MeetingRecordingRoute")[0].props.route, route);
  assert.equal(route.kind, "automatic");
  assert.equal(`${route.ownerLabel}・${route.routeLabel}`, "自社発行Meet・自動記録");
  assert.match(route.heroAction, /録音開始の操作は不要/);
  // 自社Meetの参加導線は従来どおり
  assert.equal(page.byStub("DealHero")[0].props.meetUrl, OLD_OWN_MEET);
  assert.equal(page.byStub("DealStatusBar")[0].props.deal.meetUrl, OLD_OWN_MEET);
});

test("T16 rollback: with auto-record off, own Meet keeps the browser recorder and every heading describes it", async () => {
  const page = await renderPage({ owner: "own_meet", autoRecord: false });
  assert.equal(page.byStub("MeetSessionPanel").length, 0);
  assert.deepEqual(page.mocks.statusCalls, []);
  const [recorder] = page.byStub("MeetingRecorder");
  assert.deepEqual({ ...recorder?.props }, { dealId: "d1" }, "Meet URL・ショートカットは渡さない");
  assert.equal(page.byStub("UploadRecording").length, 1);
  // 見出しと説明も、その下に出るブラウザ録音（タブ音声）を案内する。「手動添付だけ」と食い違わせない
  const manual = manualSectionOf(page);
  assert.equal(manual.title, "自社発行Meetをブラウザ録音");
  assert.match(manual.description, /ライブ商談録音の「タブ音声」/);
  assert.doesNotMatch(`${manual.title}\n${manual.description}`, /自動取得|必要な場合の手動添付/);
  // ヒーロー・記録ルート欄も「自動記録」「録音操作は不要」とは言わない（自動記録は動いていない）
  const route = page.byStub("DealHero")[0].props.recordingRoute;
  assert.equal(page.byStub("MeetingRecordingRoute")[0].props.route, route);
  assert.equal(route.kind, "browser");
  assert.equal(`${route.ownerLabel}・${route.routeLabel}`, "自社発行Meet・ブラウザ録音");
  assert.match(route.heroAction, /「タブ音声」を選んで録音を開始/);
  assert.doesNotMatch([route.routeLabel, route.heroAction, route.detail, route.note].join("\n"), /自動記録|自動取得|操作は不要/);
  // 参加先は同じ自社Meet（フラグOFFでもMeetの発行・参加は従来どおり）
  assert.equal(page.byStub("DealHero")[0].props.meetUrl, OLD_OWN_MEET);
  const statusBar = page.byStub("DealStatusBar")[0].props;
  assert.equal(statusBar.deal.meetUrl, OLD_OWN_MEET);
  assert.equal(statusBar.allowMeetIssuance, true);
});

test("T21/T24 non-own meetings keep their recorder and never receive the stale own Meet URL", async () => {
  for (const owner of NOT_OWN_MEET) {
    for (const autoRecord of [true, false]) {
      const where = `${owner}/auto=${autoRecord}`;
      const page = await renderPage({ owner, autoRecord });
      assert.equal(page.byStub("MeetSessionPanel").length, 0, where);
      assert.deepEqual(page.mocks.statusCalls, [], where);
      const [recorder] = page.byStub("MeetingRecorder");
      assert.deepEqual({ ...recorder?.props }, { dealId: "d1" }, `${where}: マイク／タブ音声の録音は変わらず使える`);
      assert.equal(page.byStub("UploadRecording").length, 1, where);
      // 会議種別を変えても meet_url は残る。ヒーロー・商談情報（閲覧者向けのMeetリンク）には渡さない
      assert.equal(page.byStub("DealHero")[0].props.meetUrl, null, where);
      const statusBar = page.byStub("DealStatusBar")[0].props;
      assert.equal(statusBar.deal.meetUrl, null, where);
      assert.equal(statusBar.allowMeetIssuance, false, where);
      const route = page.byStub("DealHero")[0].props.recordingRoute;
      assert.equal(route.ownMeet, false, where);
      assert.equal(["automatic", "browser"].includes(route.kind), false, where);
      // 自社Meet以外の手動欄の見出しは、フラグで変わらない
      assert.equal(manualSectionOf(page).title, NON_OWN_MANUAL_TITLE[owner], where);
    }
  }
});

// 会議種別の変更では meet_url・meet_event_id を消さない（アプリはCalendar予定を削除しない。
// 自社Meetへ戻したときに同じ予定・URLを再利用でき、消すと予定だけが孤立する）。上の画面側で種別により使い分ける。
test("T21 changing the meeting owner type keeps the stored own Meet link and event", async () => {
  const entry = "src/app/api/deals/[id]/route.ts";
  const mocks = { updates: [] };
  mocks.prisma = { deal: {
    findUnique: async () => ({ meetingStartAt: null, meetingEndAt: null, updatedAt: new Date("2026-09-30T00:00:00Z"),
      deletedAt: null, company: { deletedAt: null } }),
    update: async (args) => { mocks.updates.push(args); return { id: "d1", ...args.data }; },
  } };
  const route = await offlineModule(entry, mocks, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@prisma/client": "export const DealStatus={LEAD:'LEAD'};",
    "@/lib/auth": "export const getCurrentPermission=async()=>'user';export const hasPermission=()=>true;",
    "@/lib/notion-sync": "export const syncDealAppointmentDateToNotion=async()=>({ok:true,skipped:true});",
    "@/lib/deal-title": "export const buildDealTitle=()=>null;",
    "@/lib/meeting-datetime": "export const isEndBeforeStart=()=>false;export const meetingScheduledAtFromStart=()=>null;",
    "@/lib/ai/bant-definitions": "export const BANT_KEYS=[];",
    "@/components/deals/bant-summary-utils": "export const repairUtf8Mojibake=s=>s;",
    "@/lib/ai/bant-reconciliation": "export const reconcileBantFromMeetings=b=>b;",
  }, [entry, "src/lib/meetings/meeting-owner.ts"]);
  for (const owner of [...NOT_OWN_MEET, "own_meet"]) {
    const res = await route.PATCH(new Request("http://offline.invalid", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingOwnerType: owner }) }),
    { params: Promise.resolve({ id: "d1" }) });
    assert.equal(res.status, 200, owner);
    const { data } = mocks.updates.at(-1);
    assert.equal(data.meetingOwnerType, owner);
    for (const field of ["meetUrl", "meetEventId", "meetSpaceName", "meetArtifactConfigStatus"]) {
      assert.equal(field in data, false, `${owner}: ${field} を書き換えない`);
    }
  }
});
