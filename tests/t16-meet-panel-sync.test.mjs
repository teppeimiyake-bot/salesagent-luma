import assert from "node:assert/strict";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";

// T02/T16/T24（2026-09-30 クラウド確認 GM-08）：商談ページは全タブを mount したまま hidden で切り替えるので、
// 「商談記録」タブの MeetSessionPanel は作り直されない。Meet の発行・再発行の後の router.refresh() で届く
// 新しい initial に追従し、古い「未発行」や古い URL の「Meetに参加」「URLをコピー」を出し続けないことを確かめる。
//
// DOM を持たない環境なので、React のフックだけを差し替えた最小の描画器で実物のコンポーネント関数を呼ぶ
// （描画中の setState は React と同じくその場で描画し直す）。UI 部品は名前だけの要素にする。

const entry = "src/components/deals/meet-session-panel.tsx";

function makeRenderer() {
  const states = [];
  let cursor = 0;
  let dirty = false;
  const react = {
    useState(init) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof init === "function" ? init() : init;
      const set = (value) => {
        const next = typeof value === "function" ? value(states[index]) : value;
        if (!Object.is(next, states[index])) { states[index] = next; dirty = true; }
      };
      return [states[index], set];
    },
    useCallback: (fn) => fn,
    useEffect() {},
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  };
  return {
    react,
    render(Component, props) {
      let tree;
      let passes = 0;
      do {
        dirty = false;
        cursor = 0;
        tree = Component(props);
        passes++;
        assert.ok(passes < 10, "描画が収束しない（描画中の setState が繰り返されている）");
      } while (dirty);
      return tree;
    },
  };
}

const component = (name) => `export const ${name} = "${name}";`;
const boundaries = {
  react: `export const useState = (...a) => mocks.react.useState(...a);
    export const useCallback = (...a) => mocks.react.useCallback(...a);
    export const useEffect = (...a) => mocks.react.useEffect(...a);
    export const createElement = (...a) => mocks.react.createElement(...a);
    export const Fragment = "Fragment";`,
  "lucide-react": ["AlertTriangle", "Check", "Copy", "Download", "Loader2", "RefreshCw", "Video"].map(component).join("\n"),
  "@/components/ui/badge": component("Badge"),
  "@/components/ui/button": component("Button"),
  "@/components/ui/card": ["Card", "CardContent", "CardHeader", "CardTitle"].map(component).join("\n"),
  "@/lib/utils": "export const cn = (...a) => a.filter(Boolean).join(' ');",
  "@/lib/meeting-datetime": "export const toJstDateTimeInput = (v) => String(v);",
};

async function loadPanel() {
  const renderer = makeRenderer();
  const lib = await offlineModule(entry, { react: renderer.react }, boundaries);
  return { ...lib, renderer };
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function hrefsOf(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) hrefsOf(child, out); return out; }
  if (!node || typeof node !== "object") return out;
  if (node.props?.href) out.push(node.props.href);
  hrefsOf(node.props?.children, out);
  return out;
}

const OLD_URL = "https://meet.google.com/dbb-abcd-jgg";
const NEW_URL = "https://meet.google.com/pje-efgh-zje";
const status = (overrides) => ({
  meetUrl: null, meetSpaceName: null, configStatus: null, configError: null,
  artifactStatus: null, artifactError: null, attempts: 0, checkedAt: null,
  conferenceRecordId: null, latestMeetingId: null, phase: "no_schedule", ...overrides,
});
const props = (initial) => ({ dealId: "demo", enabled: true, canEdit: true, initial });

test("GM-08 the record tab panel follows the issued Meet without a reload", async () => {
  const { MeetSessionPanel, renderer } = await loadPanel();
  const before = renderer.render(MeetSessionPanel, props(status({})));
  assert.match(textOf(before), /Meet URLがまだ発行されていません/);
  assert.deepEqual(hrefsOf(before), []);

  // 概要タブで日時を保存して発行 → router.refresh() でサーバーの新しい状態が同じパネルに届く
  const issued = status({ meetUrl: OLD_URL, meetSpaceName: "spaces/a", configStatus: "configured", phase: "configured" });
  const after = renderer.render(MeetSessionPanel, props(issued));
  assert.match(textOf(after), /商談前（自動記録の準備完了）/);
  assert.match(textOf(after), /Meetに参加/);
  assert.match(textOf(after), /設定済み/);
  assert.doesNotMatch(textOf(after), /Meet URLがまだ発行されていません|商談日時が未設定です/);
  assert.deepEqual(hrefsOf(after), [OLD_URL]);
});

test("GM-08 after a reissue the panel shows only the new URL, not the old join link", async () => {
  const { MeetSessionPanel, renderer } = await loadPanel();
  renderer.render(MeetSessionPanel, props(status({ meetUrl: OLD_URL, configStatus: "configured", phase: "configured" })));
  const reissued = renderer.render(MeetSessionPanel, props(status({ meetUrl: NEW_URL, configStatus: "configured", phase: "configured" })));
  assert.deepEqual(hrefsOf(reissued), [NEW_URL]);
  assert.ok(textOf(reissued).includes(NEW_URL));
  assert.ok(!textOf(reissued).includes(OLD_URL), "古い URL が残っている");
});

test("an unchanged server state does not overwrite the panel, and a changed key is detected field by field", async () => {
  const { MeetSessionPanel, meetSessionStatusKey, renderer } = await loadPanel();
  const initial = status({ meetUrl: OLD_URL, phase: "scheduled" });
  const first = renderer.render(MeetSessionPanel, props(initial));
  // 同じ内容の新しいオブジェクト（別の理由の router.refresh()）では描画し直しを起こさない
  const again = renderer.render(MeetSessionPanel, props({ ...initial }));
  assert.equal(textOf(again), textOf(first));
  for (const [field, value] of Object.entries({
    meetUrl: NEW_URL, meetSpaceName: "spaces/b", configStatus: "failed", configError: "x", artifactStatus: "failed",
    artifactError: "y", attempts: 3, checkedAt: "2026-09-30T00:00:00.000Z", conferenceRecordId: "conferenceRecords/a",
    latestMeetingId: "m1", phase: "needs_attention",
  })) {
    assert.notEqual(meetSessionStatusKey({ ...initial, [field]: value }), meetSessionStatusKey(initial), field);
  }
});
