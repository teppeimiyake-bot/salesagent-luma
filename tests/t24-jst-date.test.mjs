import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// T24 React #418: the server (Cloud Run, UTC) and the browser (JST) must render
// identical date text. TZ is read when Date is first used, so each timezone runs
// in its own child process; the parent compares the children's outputs.
const CHILD = "T24_JST_DATE_CHILD";
const TIMEZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles"];
const NOW = "2026-09-23T15:42:00Z"; // JST 2026-09-24 00:42, still 09-23 in UTC
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Bundles a real date-input component with React/Next stubbed so its render output
// (the <input type="date"> value) and its real onChange handler can be driven
// without a DOM. Only the component, due-date.ts and meeting-datetime.ts are real.
const nullComponents = (...names) => names.map((n) => `export const ${n}=()=>null;`).join("");
async function loadDateInputComponent(entry, globals = {}) {
  const { build } = await import("esbuild");
  const real = new Set(["src/lib/due-date.ts", "src/lib/meeting-datetime.ts"].map((f) => path.join(ROOT, f)));
  const stubs = {
    react: "export const useTransition=()=>[false,fn=>{mocks.pending.push(fn())}];export const useState=v=>[typeof v==='function'?v():v,()=>{}];export const useEffect=()=>{};export const useRef=v=>({current:v});",
    "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
    "next/navigation": "export const useRouter=()=>({refresh(){mocks.refreshes++}});",
    "lucide-react": nullComponents("AlertTriangle", "Sparkles", "FileSignature", "Target", "Sparkle", "Calendar",
      "NotebookPen", "CalendarClock", "Video", "Copy", "ExternalLink", "RefreshCw"),
    "@/components/ui/due-badge": "export const DueBadge=()=>null;",
    "@/components/deals/next-action-input": "export const NextActionInput=()=>null;",
    "@/lib/deal-aggregations": "export const YOMI_OPTIONS=[];export const yomiColor=()=>({});",
    "@/lib/yomi-status": "export const stripYomiPrefix=v=>v;",
    // DealStatusBar only: its text-typed DateInput is kept as a marked element so its props can be driven.
    "@/components/ui/card": nullComponents("Card", "CardContent"),
    "@/components/ui/badge": nullComponents("Badge"),
    "@/components/ui/button": nullComponents("Button"),
    "@/components/ui/select": nullComponents("Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"),
    "@/components/ui/input": nullComponents("Input"),
    "@/components/ui/label": nullComponents("Label"),
    "@/components/ui/date-input": "export const DateInput=Object.assign(()=>null,{t24DateInput:true});",
    "@/components/deals/meeting-datetime-editor": nullComponents("MeetingDateTimeEditor"),
    "@/lib/deal-status": "export const STATUS_LABEL={};export const statusColor=()=>'default';",
    "@/lib/pipeline-stage": "export const STAGE_GROUP_LABEL={};export const findStageFromRows=()=>null;export const rowToStageDef=r=>r;",
    "@/lib/lead-source": "export const leadSourceColor=()=>({});",
  };
  const result = await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral",
    jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "t24-stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
        if (a.path in stubs) return { path: a.path, namespace: "stub" };
        const file = a.path.startsWith("@/") ? path.join(ROOT, "src", `${a.path.slice(2)}.ts`) : null;
        if (file && real.has(file)) return { path: file };
        return { errors: [{ text: `Unexpected dependency of ${entry}: ${a.path}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    } }],
  });
  // 保存（PATCH）は成功として答える（DealStatusBar は res.ok を見て、失敗なら元の値に戻す）
  const ok = () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } });
  const mocks = { pending: [], requests: [], refreshes: 0, ok, respond: ok };
  const loaded = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    ...globals,
    module: loaded, exports: loaded.exports, mocks,
    fetch: async (url, init) => {
      mocks.requests.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) });
      return mocks.respond(url);
    },
  });
  return { exports: loaded.exports, mocks };
}

function findAll(node, match, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (match(node)) found.push(node);
  return findAll(node.props?.children, match, found);
}

function findDateInput(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDateInput(child);
      if (found) return found;
    }
    return null;
  }
  // 先方の自前カレンダー DateInput（2026-09 社長報告。標準の日付入力は月送りだけで保存されるため使わない）も対象にする。
  if ((node.type === "input" && node.props?.type === "date") || node.type?.t24DateInput) return node;
  return findDateInput(node.props?.children);
}

async function driveDateInput(entry, name, valueProp, extraProps) {
  const { exports, mocks } = await loadDateInputComponent(entry);
  const render = (value) => findDateInput(exports[name]({ dealId: "d1", [valueProp]: value, ...extraProps }));
  const input = render("2026-08-10T15:00:00Z");
  // A date the user picks, a year boundary, clearing the field, and an impossible date.
  for (const value of ["2026-08-11", "2027-01-01", "", "2026-02-30"]) {
    // DateInput は "YYYY-MM-DD" をそのまま渡す。標準の日付入力はイベントで渡す。
    if (input.type?.t24DateInput) input.props.onChange(value);
    else input.props.onChange({ target: { value } });
  }
  await Promise.all(mocks.pending);
  return {
    inputValue: input.props.value,
    requests: mocks.requests,
    refreshes: mocks.refreshes,
    valueOf: (d) => render(d).props.value,
  };
}

// The deal detail's status bar: four DateInputs (next action, first meeting, expected close, booked date)
// in render order. Date is fixed at NOW so 本日でセット is deterministic.
async function driveDealStatusBar() {
  const fixedNow = Date.parse(NOW);
  class FixedNowDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const { exports, mocks } = await loadDateInputComponent("src/components/deals/deal-status.tsx", { Date: FixedNowDate });
  const render = (value) => exports.DealStatusBar({
    deal: {
      id: "d1", status: "LEAD", pipelineStage: null, nextAction: "決裁者に見積を送る", nextActionAt: value,
      appointmentDate: value, contractDate: value, expectedCloseDate: value,
      leadSourceId: null, leadSource: null, leadSourceMemo: null, owner: null,
    },
    users: [],
  });
  const dateInputs = (value) => findAll(render(value), (n) => n.type?.t24DateInput).map((n) => n.props);
  const button = (value, match) => findAll(render(value), (n) => match(n.props ?? {}))[0].props;
  const drain = async () => {
    await Promise.all(mocks.pending);
    const sent = mocks.requests.splice(0);
    mocks.pending.length = 0;
    return sent;
  };

  const shown = {
    jstMidnight: dateInputs("2026-08-10T15:00:00Z").map((p) => p.value),
    utcMidnight: dateInputs("2026-08-11T00:00:00.000Z").map((p) => p.value),
    empty: dateInputs(null).map((p) => p.value),
  };
  const saved = {};
  const fields = ["nextActionAt", "appointmentDate", "expectedCloseDate", "contractDate"];
  for (const [i, field] of fields.entries()) {
    const input = dateInputs("2026-08-10T15:00:00Z")[i];
    for (const value of ["2026-08-11", "2027-01-01", "", "2026-02-30"]) input.onChange(value);
    saved[field] = await drain();
  }

  const setToday = button(null, (p) => p.children === "本日でセット");
  setToday.onClick();
  const today = await drain();

  const suggestions = [];
  for (const nextActionAt of ["2026-08-11", "2026-02-30"]) {
    mocks.respond = (url) => url.endsWith("/suggest-next-action")
      ? { json: async () => ({ suggestion: { next_action: "決裁者との面談日を確定する", next_action_at: nextActionAt } }) }
      : mocks.ok();
    await button("2026-08-10T15:00:00Z", (p) => p.title === "AIに次の一手を提案させる").onClick();
    suggestions.push(await drain());
  }
  return { shown, saved, today, suggestions, refreshes: mocks.refreshes };
}

async function collect() {
  const require = createRequire(import.meta.url);
  const { createElement } = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { daysUntil, dueState, jstMonthDayLabel, jstDateInputToIso } = require("../src/lib/due-date.ts");
  const { formatDate } = require("../src/lib/utils.ts");
  const { resolveBantCardView } = require("../src/components/deals/bant-summary-utils.ts");
  const { DueBadge } = require("../src/components/ui/due-badge.tsx");
  const now = new Date(NOW);
  const detailInput = await driveDateInput(
    "src/components/deals/next-action-date-input.tsx", "NextActionDateInput", "value", { showBadge: false },
  );
  const listInput = await driveDateInput(
    "src/components/deals/deal-inline-edit.tsx", "DealNextActionEdit", "nextActionAt", { nextAction: null },
  );
  const dealStatus = await driveDealStatusBar();

  // Sweep hourly across month/year boundaries for the pre-fix JST comparison.
  const sweep = [];
  for (const start of ["2026-08-09T00:00:00Z", "2026-12-30T00:00:00Z"]) {
    for (let h = 0; h < 72; h++) sweep.push(new Date(Date.parse(start) + h * 3600_000));
  }
  const legacy = {
    // The pre-fix local-time implementations; equal to the new output only under JST.
    daysUntil(d, base) {
      const target = new Date(d); target.setHours(0, 0, 0, 0);
      const today = new Date(base); today.setHours(0, 0, 0, 0);
      return Math.round((target.getTime() - today.getTime()) / 86400000);
    },
    monthDay: (d) => `${d.getMonth() + 1}/${d.getDate()}`,
    formatDate: (d) => d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }),
    inputValue: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    saveIso: (v) => new Date(`${v}T00:00:00`).toISOString(),
  };

  return {
    tz: process.env.TZ,
    daysUntil: {
      overdue: daysUntil("2026-08-10T15:00:00Z", now),
      jstMidnight: daysUntil("2026-09-23T15:00:00Z", now),
      tomorrowAtJstMidnight: daysUntil("2026-09-24T15:00:00Z", now),
      lateOnJstDay: daysUntil("2026-09-24T14:59:59Z", now),
      beforeJstMidnight: daysUntil("2026-09-23T15:00:00Z", new Date("2026-09-23T14:59:00Z")),
      invalid: daysUntil("not a date", now),
      empty: daysUntil(null, now),
    },
    dueState: [
      dueState("2026-09-23T14:59:59Z", now),
      dueState("2026-09-23T15:00:00Z", now),
      dueState("2026-09-24T15:00:00Z", now),
      dueState(null, now),
    ],
    monthDay: [jstMonthDayLabel("2026-08-10T15:00:00Z"), jstMonthDayLabel(new Date("2026-12-31T15:00:00Z"))],
    formatDate: [
      formatDate("2026-08-10T15:00:00Z"),
      formatDate(new Date("2026-12-31T15:00:00Z")),
      formatDate(null),
    ],
    saveIso: ["2026-08-11", "2027-01-01", "2028-02-29", "2026-02-30", "2026-8-1", "2026-08-11T09:00", ""].map(
      (v) => jstDateInputToIso(v),
    ),
    detailInput: { inputValue: detailInput.inputValue, requests: detailInput.requests, refreshes: detailInput.refreshes },
    listInput: { inputValue: listInput.inputValue, requests: listInput.requests, refreshes: listInput.refreshes },
    dealStatus,
    bantSource: resolveBantCardView(
      { budget: "80万円", items: { budget: { value: "80万円", source_meeting_id: "m1", quote: "予算は80万円" } } },
      "budget",
      [{ id: "m1", title: "予算確認", meetingDate: "2026-08-10T15:00:00Z" }],
    ).source?.label,
    // done=true keeps the label independent of the real current date.
    badge: renderToStaticMarkup(createElement(DueBadge, { date: "2026-08-10T15:00:00Z", done: true })),
    sweep: sweep.map((d) => ({
      daysUntil: daysUntil(d, now),
      monthDay: jstMonthDayLabel(d),
      formatDate: formatDate(d),
      inputValue: detailInput.valueOf(d),
    })),
    listSweepInputValue: sweep.map((d) => listInput.valueOf(d)),
    legacySweep: sweep.map((d) => ({
      daysUntil: legacy.daysUntil(d, now),
      monthDay: legacy.monthDay(d),
      formatDate: legacy.formatDate(d),
      inputValue: legacy.inputValue(d),
    })),
    legacySaveIso: legacy.saveIso("2026-08-11"),
  };
}

function runIn(tz) {
  const env = { ...process.env, TZ: tz, [CHILD]: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

if (process.env[CHILD]) {
  process.stdout.write(JSON.stringify(await collect()));
} else {
  const results = Object.fromEntries(TIMEZONES.map((tz) => [tz, runIn(tz)]));

  test("children really ran under different process timezones", () => {
    for (const tz of TIMEZONES) assert.equal(results[tz].tz, tz);
  });

  test("date text and day differences are identical on UTC, JST and US servers", () => {
    const strip = (result) => {
      const rest = { ...result };
      delete rest.tz;
      delete rest.legacySweep;
      delete rest.legacySaveIso;
      return rest;
    };
    const jst = strip(results["Asia/Tokyo"]);
    for (const tz of TIMEZONES) assert.deepEqual(strip(results[tz]), jst, `${tz} differs from Asia/Tokyo`);
  });

  test("days are counted on JST calendar days", () => {
    assert.deepEqual(results.UTC.daysUntil, {
      overdue: -44,
      jstMidnight: 0,
      tomorrowAtJstMidnight: 1,
      lateOnJstDay: 0,
      beforeJstMidnight: 1,
      invalid: null,
      empty: null,
    });
    assert.deepEqual(results.UTC.dueState, ["overdue", "today", "future", "future"]);
  });

  test("labels use the JST date (8/11 for 2026-08-10T15:00Z)", () => {
    const r = results.UTC;
    assert.deepEqual(r.monthDay, ["8/11", "1/1"]);
    assert.deepEqual(r.formatDate, ["2026/08/11", "2027/01/01", "—"]);
    assert.equal(r.bantSource, "出典：予算確認（8/11）");
    assert.match(r.badge, />完了<\/span><span[^>]*>8\/11<\/span>/);
  });

  test("date inputs show the JST day and save the picked day as JST midnight on every timezone", () => {
    const expectedRequests = [
      { url: "/api/deals/d1", method: "PATCH", body: { nextActionAt: "2026-08-10T15:00:00.000Z" } },
      { url: "/api/deals/d1", method: "PATCH", body: { nextActionAt: "2026-12-31T15:00:00.000Z" } },
      { url: "/api/deals/d1", method: "PATCH", body: { nextActionAt: null } },
      // "2026-02-30" is rejected instead of rolling over to 3/2.
    ];
    for (const tz of TIMEZONES) {
      const r = results[tz];
      assert.deepEqual(
        r.saveIso,
        ["2026-08-10T15:00:00.000Z", "2026-12-31T15:00:00.000Z", "2028-02-28T15:00:00.000Z", null, null, null, null],
        tz,
      );
      for (const component of ["detailInput", "listInput"]) {
        assert.equal(r[component].inputValue, "2026-08-11", `${tz} ${component}`);
        assert.deepEqual(r[component].requests, expectedRequests, `${tz} ${component}`);
        assert.equal(r[component].refreshes, expectedRequests.length, `${tz} ${component}`);
      }
      // The list row and the deal detail show the same day for every hour of the sweep.
      assert.deepEqual(r.listSweepInputValue, r.sweep.map((entry) => entry.inputValue), tz);
    }
    // The previous `${v}T00:00:00` parse depended on the browser timezone.
    assert.equal(results["Asia/Tokyo"].legacySaveIso, "2026-08-10T15:00:00.000Z");
    assert.equal(results.UTC.legacySaveIso, "2026-08-11T00:00:00.000Z");
    assert.equal(results["America/Los_Angeles"].legacySaveIso, "2026-08-11T07:00:00.000Z");
  });

  test("JST output is unchanged from the previous local-time implementation", () => {
    const jst = results["Asia/Tokyo"];
    assert.deepEqual(jst.sweep, jst.legacySweep);
    // The previous code rendered a different day on a UTC server: the #418 mismatch.
    assert.notDeepEqual(results.UTC.legacySweep, jst.legacySweep);
  });

  test("DealStatusBar shows JST days; only the next action is saved at JST midnight", () => {
    const patch = (body) => ({ url: "/api/deals/d1", method: "PATCH", body });
    // Other deal fields keep UTC midnight: KPI months, Notion and the contract PDF cut dates in UTC.
    const utcMidnight = (field) => [
      patch({ [field]: "2026-08-11T00:00:00.000Z" }),
      patch({ [field]: "2027-01-01T00:00:00.000Z" }),
      patch({ [field]: null }),
    ];
    for (const tz of TIMEZONES) {
      const r = results[tz].dealStatus;
      // A JST-midnight value (2026-08-10T15:00Z) used to show 2026-08-10 on every input.
      assert.deepEqual(r.shown.jstMidnight, ["2026-08-11", "2026-08-11", "2026-08-11", "2026-08-11"], tz);
      assert.deepEqual(r.shown.utcMidnight, ["2026-08-11", "2026-08-11", "2026-08-11", "2026-08-11"], tz);
      assert.deepEqual(r.shown.empty, ["", "", "", ""], tz);
      // "2026-02-30" sends nothing instead of rolling over to 3/2.
      assert.deepEqual(r.saved.nextActionAt, [
        patch({ nextActionAt: "2026-08-10T15:00:00.000Z" }),
        patch({ nextActionAt: "2026-12-31T15:00:00.000Z" }),
        patch({ nextActionAt: null }),
      ], tz);
      for (const field of ["appointmentDate", "expectedCloseDate", "contractDate"]) {
        assert.deepEqual(r.saved[field], utcMidnight(field), `${tz} ${field}`);
      }
      // NOW is 2026-09-24 00:42 JST while UTC is still 09-23.
      assert.deepEqual(r.today, [patch({ contractDate: "2026-09-24T00:00:00.000Z" })], tz);
      const suggest = { url: "/api/deals/d1/suggest-next-action", method: "POST" };
      assert.deepEqual(r.suggestions, [
        [suggest, patch({ nextAction: "決裁者との面談日を確定する", nextActionAt: "2026-08-10T15:00:00.000Z" })],
        [suggest, patch({ nextAction: "決裁者との面談日を確定する" })],
      ], tz);
      assert.equal(r.refreshes, 3 + 3 * 3 + 1 + 2, tz);
    }
  });
}
