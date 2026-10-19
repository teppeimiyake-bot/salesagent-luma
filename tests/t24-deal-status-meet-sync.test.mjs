import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 商談の状態欄（DealStatusBar）について、2026-09-30 のクラウド確認で見つかった2点を確かめる。
// - T24（GM-09 / P5）：390px 幅で「次回アクション」の入力が幅29pxに潰れた。入力・期日・AI提案を
//   折り返しのない1行に並べていたため。狭い幅では入力を1行使い、期日と「AI提案」を次の行に回す。
// - T02（GM-06）：Google カレンダー側で予定が削除されていた商談で「同期」すると、サーバーは新しい予定・Meet を
//   作り直す。URL が変わったことを「Meetを同期しました。」で済ませず、送り直しが要ると伝える。
// DOM を持たないので、React と UI 部品を差し替えて実物のコンポーネント関数を呼ぶ（tests/t24-jst-date.test.mjs と同じ方式）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marked = (...names) => names.map((n) => `export const ${n}=Object.assign(()=>null,{t24:"${n}"});`).join("");

async function loadDealStatus() {
  const { build } = await import("esbuild");
  const real = new Set(["src/lib/due-date.ts", "src/lib/meeting-datetime.ts"].map((f) => path.join(ROOT, f)));
  const stubs = {
    react: "export const useTransition=()=>[false,fn=>{mocks.pending.push(fn())}];export const useState=v=>[typeof v==='function'?v():v,x=>{mocks.sets.push(x)}];export const useEffect=()=>{};export const useRef=v=>({current:v});",
    "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
    "next/navigation": "export const useRouter=()=>({refresh(){mocks.refreshes++}});",
    "lucide-react": marked("Sparkles", "FileSignature", "Target", "Sparkle", "Calendar", "NotebookPen", "CalendarClock",
      "Video", "Copy", "ExternalLink", "RefreshCw"),
    "@/components/ui/due-badge": marked("DueBadge"),
    "@/components/ui/card": marked("Card", "CardContent"),
    "@/components/ui/badge": marked("Badge"),
    "@/components/ui/button": marked("Button"),
    "@/components/ui/select": marked("Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"),
    "@/components/ui/input": marked("Input"),
    "@/components/ui/label": marked("Label"),
    "@/components/ui/date-input": marked("DateInput"),
    "@/components/deals/meeting-datetime-editor": marked("MeetingDateTimeEditor"),
    "@/lib/deal-status": "export const STATUS_LABEL={};export const statusColor=()=>'default';",
    "@/lib/pipeline-stage": "export const STAGE_GROUP_LABEL={};export const findStageFromRows=()=>null;export const rowToStageDef=r=>r;",
    "@/lib/lead-source": "export const leadSourceColor=()=>({});",
  };
  const result = await build({
    absWorkingDir: ROOT, entryPoints: ["src/components/deals/deal-status.tsx"], bundle: true, write: false,
    format: "cjs", platform: "neutral", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "t24-stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
        if (a.path in stubs) return { path: a.path, namespace: "stub" };
        const file = a.path.startsWith("@/") ? path.join(ROOT, "src", `${a.path.slice(2)}.ts`) : null;
        if (file && real.has(file)) return { path: file };
        return { errors: [{ text: `Unexpected dependency: ${a.path}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    } }],
  });
  const mocks = { pending: [], sets: [], requests: [], refreshes: 0, respond: () => { throw Error("no response"); } };
  const loaded = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module: loaded, exports: loaded.exports, mocks, setTimeout,
    fetch: async (url, init = {}) => {
      mocks.requests.push({ url, method: init.method, body: init.body });
      return mocks.respond(url, init);
    },
  });
  return { ...loaded.exports, mocks };
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
const childrenOf = (node) => [node.props?.children].flat(Infinity);

const OLD_URL = "https://meet.google.com/old-link-xyz";
const NEW_URL = "https://meet.google.com/new-link-abc";
const deal = (overrides = {}) => ({
  id: "d1", status: "LEAD", pipelineStage: null, nextAction: "決裁者に見積を送る", nextActionAt: null,
  appointmentDate: null, contractDate: null, expectedCloseDate: null,
  meetingStartAt: "2026-10-07T05:00:00.000Z", meetingEndAt: "2026-10-07T05:30:00.000Z",
  meetUrl: OLD_URL, meetEventId: "deleted",
  leadSourceId: null, leadSource: null, leadSourceMemo: null, owner: null, ...overrides,
});

test("T24 390px and 1440px: the next-action input gets its own full-width row; date and AI suggestion wrap below", async () => {
  const { DealStatusBar } = await loadDealStatus();
  const tree = DealStatusBar({ deal: deal(), users: [] });
  const input = findAll(tree, (n) => n.type?.t24 === "Input" && n.props.placeholder?.startsWith("次回やること"))[0];
  assert.ok(input, "次回アクションの入力が無い");
  assert.match(input.props.className, /\bw-full\b/);
  assert.match(input.props.className, /\bmin-w-0\b/);
  // The row stacks while the field itself is narrower than 36rem (a container query, not the viewport): on a 390px phone
  // and also at 1440px, where the field is only 2/3 of the left column and the one-line layout left the input 119px
  // wide (2026-10-01 recheck G11). It becomes one line only where the input keeps >= 15rem next to the date and button.
  const row = findAll(tree, (n) => n.type === "div" && childrenOf(n).includes(input))[0];
  assert.match(row.props.className, /\bflex-col\b/);
  assert.match(row.props.className, /(^|\s)@xl:flex-row(\s|$)/);
  assert.doesNotMatch(row.props.className, /(^|\s)(sm:|md:|lg:|xl:)?flex-row(\s|$)/);
  assert.match(input.props.className, /(^|\s)@xl:flex-1(\s|$)/);
  const field = findAll(tree, (n) => n.type === "div" && findAll(n, (c) => c === row).length > 0 && /md:col-span-2/.test(n.props.className ?? ""))[0];
  assert.match(field.props.className, /(^|\s)@container(\s|$)/);
  // The date input and the AI suggestion button stay together on the next line.
  const group = childrenOf(row).find((n) => n?.type === "div");
  const groupTypes = childrenOf(group).map((n) => n?.type?.t24);
  assert.deepEqual(groupTypes, ["DateInput", "Button"]);
  assert.match(group.props.className, /\bshrink-0\b/);
});

test("T02 sync message: a URL replaced by the server is announced; ordinary syncs and reissues keep their wording", async () => {
  const { meetSyncSuccessMessage } = await loadDealStatus();
  assert.equal(meetSyncSuccessMessage({ forceRecreate: false, previousUrl: OLD_URL, nextUrl: OLD_URL }), "Meetを同期しました。");
  assert.equal(meetSyncSuccessMessage({ forceRecreate: false, previousUrl: "", nextUrl: NEW_URL }), "Meetを同期しました。");
  assert.equal(meetSyncSuccessMessage({ forceRecreate: true, previousUrl: OLD_URL, nextUrl: NEW_URL }), "Meetを再発行しました。");
  const replaced = meetSyncSuccessMessage({ forceRecreate: false, previousUrl: OLD_URL, nextUrl: NEW_URL });
  assert.match(replaced, /予定が見つからなかったため、新しいMeetを発行しました/);
  assert.match(replaced, /新しいURLを送り直してください/);
});

test("T02 pressing 同期 on a deal whose Calendar event was deleted shows the replacement message and refreshes the page", async () => {
  const { DealStatusBar, mocks } = await loadDealStatus();
  mocks.respond = () => ({ ok: true, status: 200, json: async () => ({ deal: { meetUrl: NEW_URL, meetEventId: "replacement" } }) });
  const tree = DealStatusBar({ deal: deal(), users: [], showMeetingDateTime: true });
  const sync = findAll(tree, (n) => n.type?.t24 === "Button" && childrenOf(n).includes("同期"))[0];
  assert.ok(sync, "「同期」ボタンが無い");
  await sync.props.onClick();
  assert.equal(mocks.requests.length, 1);
  assert.deepEqual(JSON.parse(mocks.requests[0].body), { forceRecreate: false });
  assert.ok(mocks.sets.some((v) => typeof v === "string" && /新しいMeetを発行しました/.test(v)), "URL が変わったことを伝えていない");
  assert.ok(!mocks.sets.includes("Meetを同期しました。"));
  // The rest of the page (e.g. the record tab's Meet panel) re-reads the server state.
  assert.equal(mocks.refreshes, 1);
});
