// 商談詳細の残り（クラウドの最終確認で発見）：
//   1. 閲覧のみでは、商談記録（新しい商談を記録・分析を実行・文字起こし再実行・AI再分析・ラベル保存・編集・削除）、
//      見積・契約タブの資料・契約書の「追加」と削除、概要の次回アクション・期日・フェーズ・ステージ・担当を出さない・無効にする。
//   2. 403 のときは英語の「Forbidden」ではなく日本語の理由を出し、次回アクションは保存に失敗したら元の値に戻す。
//      API も、書き込みの 403 は requireWriter と同じ文言（閲覧のみ／全社統合ビューなら会社の切り替え）にそろえる。
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findAll, mountComponent, textOf } from "./helpers/component-harness.mjs";
import { offlineModule } from "./helpers/offline-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (file) => readFile(path.join(ROOT, file), "utf8");

// component-harness の読み込みに next/link の差し替えを足したもの
async function load(entry) {
  const elements = "module.exports=Object.create(new Proxy({}, {get(_, name){if (typeof name !== 'string' || name === '__esModule' || name === 'then') return undefined;return (props)=>({type:name,props});}}));";
  const hooks = ["useState", "useRef", "useEffect", "useLayoutEffect", "useCallback", "useMemo", "useId", "useTransition"];
  const stubs = {
    react: hooks.map((h) => `export const ${h}=(...a)=>globalThis.__hooks.${h}(...a);`).join("") + "export default {};",
    "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;",
    "next/navigation": "export const useRouter=()=>globalThis.__router;",
    "next/link": "export default (props)=>({type:'Link',props});",
    "react-markdown": "export default (props)=>({type:'markdown',props});",
  };
  const result = await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.path in stubs) return { path: a.path, namespace: "stub" };
        if (a.path === "lucide-react" || a.path.startsWith("@/components/ui/")) return { path: a.path, namespace: "elements" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "elements" }, () => ({ contents: elements, loader: "js" }));
    } }],
  });
  return result.outputFiles[0].text;
}

const DEAL = {
  id: "deal-1", status: "HEARING", pipelineStage: null, nextAction: "元の次回アクション", nextActionAt: null, appointmentDate: null,
  contractDate: null, expectedCloseDate: null, leadSourceId: null, leadSource: null, leadSourceMemo: null, owner: null,
};
const statusBundle = await load("src/components/deals/deal-status.tsx");
const answer = (request) => {
  if (request.method === "GET") return Response.json({ stages: [], leadSources: [] });
  return undefined;
};

test("概要（商談の状態）: 閲覧のみでは、次回アクション・期日・フェーズ・ステージ・担当を無効にする", async () => {
  const app = mountComponent(statusBundle, "DealStatusBar", { deal: DEAL, users: [], canEdit: false }, answer);
  await app.settle();
  const tree = app.tree();
  const selects = findAll(tree, (n) => n.type === "Select");
  assert.ok(selects.length >= 3);
  for (const s of selects) assert.equal(s.props.disabled, true);
  const next = findAll(tree, (n) => n.type === "Input" && n.props.placeholder?.startsWith("次回やること"))[0];
  assert.equal(next.props.disabled, true);
  for (const d of findAll(tree, (n) => n.type === "DateInput")) assert.equal(d.props.disabled, true);
});

test("概要（商談の状態）: 保存が 403 なら、日本語の理由を出し、次回アクションを元の値に戻す", async () => {
  const reason = "閲覧のみの権限では、この操作はできません。";
  const app = mountComponent(statusBundle, "DealStatusBar", { deal: DEAL, users: [] }, (request) => {
    if (request.method === "PATCH") return Response.json({ error: reason }, { status: 403 });
    return answer(request);
  });
  await app.settle();
  let next = findAll(app.tree(), (n) => n.type === "Input" && n.props.placeholder?.startsWith("次回やること"))[0];
  next.props.onChange({ target: { value: "入力した次回アクション" } });
  await app.settle();
  next = findAll(app.tree(), (n) => n.type === "Input" && n.props.placeholder?.startsWith("次回やること"))[0];
  next.props.onBlur({ target: { value: "入力した次回アクション" } });
  await app.settle();
  const tree = app.tree();
  assert.match(textOf(tree), /閲覧のみの権限では、この操作はできません。/);
  assert.doesNotMatch(textOf(tree), /Forbidden/);
  next = findAll(tree, (n) => n.type === "Input" && n.props.placeholder?.startsWith("次回やること"))[0];
  assert.equal(next.props.value, "元の次回アクション");
});

test("概要（商談の状態）: 403 の本文が英語（Forbidden）でも、日本語の理由に置き換える", async () => {
  const app = mountComponent(statusBundle, "DealStatusBar", { deal: DEAL, users: [] }, (request) => {
    if (request.method === "PATCH") return Response.json({ error: "Forbidden" }, { status: 403 });
    return answer(request);
  });
  await app.settle();
  const select = findAll(app.tree(), (n) => n.type === "Select")[1];
  select.props.onValueChange("PROPOSAL");
  await app.settle();
  assert.doesNotMatch(textOf(app.tree()), /Forbidden/);
  assert.match(textOf(app.tree()), /権限/);
});

test("商談記録・資料・契約書: 閲覧のみでは操作のボタンを出さない（部品に canEdit を渡す）", async () => {
  const page = await src("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /<MeetingHistory dealId=\{deal\.id\} meetings=\{deal\.meetings\} canEdit=\{canEdit\} \/>/);
  assert.match(page, /<DealDocuments dealId=\{deal\.id\} companyName=\{deal\.company\.name\} canEdit=\{canEdit\} \/>/);
  assert.match(page, /<DealContracts dealId=\{deal\.id\} companyName=\{deal\.company\.name\} canEdit=\{canEdit\} \/>/);

  const history = await src("src/components/deals/meeting-history.tsx");
  assert.match(history, /export function MeetingHistory\(\{\s*dealId,\s*meetings,\s*canEdit = true,/);
  assert.match(history, /\{canEdit && \(\s*<Button size="sm" variant="primary" disabled=\{adding \|\| pending\}/, "新しい商談を記録");
  assert.match(history, /\{canEdit && \(\s*<span\s+onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*remove\(m\.id\);/, "削除");
  assert.match(history, /canEdit && \(processingStatus === "transcribed"/, "分析を実行");
  assert.match(history, /<MeetingTitleEditor meetingId=\{m\.id\} initialTitle=\{m\.title\} canEdit=\{canEdit\} \/>/);
  assert.match(history, /<MinutesEditor[\s\S]{0,400}canEdit=\{canEdit\}/);
  const minutes = await src("src/components/deals/minutes-editor.tsx");
  assert.match(minutes, /\{canEdit && \(\s*<div className="ml-auto flex shrink-0 flex-wrap gap-2">/, "編集・AI再分析");

  for (const file of ["src/components/deals/deal-documents.tsx", "src/components/deals/deal-contracts.tsx"]) {
    const text = await src(file);
    assert.match(text, /canEdit = true/, file);
    assert.match(text, /\{canEdit && \(\s*<Button size="sm" variant="primary" onClick=\{\(\) => \{ setOpen\(!open\)/, `${file} 追加`);
    assert.match(text, /\{canEdit && \(\s*<button[\s\S]{0,40}onClick=\{\(\) => remove\(d\.id\)\}/, `${file} 削除`);
  }
});

test("商談記録（MeetingHistory）: 閲覧のみでは、新しい商談を記録・ラベル保存・編集・AI再分析を出さない（実物で確かめる）", async () => {
  const bundle = await load("src/components/deals/meeting-history.tsx");
  const meeting = {
    id: "m-1", title: "架空の回", meetingDate: "2026-10-01T00:00:00Z", summary: "要約", minutes: "議事録", transcript: "",
    processingStatus: "completed", recordingUrl: null, bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: null,
  };
  const app = mountComponent(bundle, "MeetingHistory", { dealId: "deal-1", meetings: [meeting], canEdit: false }, () => Response.json({}));
  await app.settle();
  const text = textOf(app.tree());
  for (const label of ["新しい商談を記録", "ラベル保存", "AI再分析", "分析再実行", "分析を実行"]) assert.doesNotMatch(text, new RegExp(label), label);
  assert.equal(findAll(app.tree(), (n) => n.props?.title === "削除").length, 0);
});

// ---- API の 403 の文言 ----------------------------------------------------------

test("writeForbidden: 全社統合ビューなら会社の切り替え、それ以外は閲覧のみの理由", async () => {
  const loadGuard = (ctx) => offlineModule("src/lib/write-guard.ts", { ctx }, {
    "@/lib/auth": "export const getSession=async()=>({userId:'u'});export const getCurrentPermission=async()=>'viewer';export const hasPermission=()=>false;",
    "@/lib/tenant-context": "export const currentTenant=()=>mocks.ctx;export const getRequestTenant=async()=>mocks.ctx;",
  }, ["src/lib/write-guard.ts"]);
  const cross = await (await loadGuard({ crossTenant: true })).writeForbidden();
  assert.equal(cross.status, 403);
  assert.match((await cross.json()).error, /全社統合ビュー[\s\S]*切り替えて/);
  const viewer = await (await loadGuard({ crossTenant: false, tenantId: "t" })).writeForbidden();
  assert.match((await viewer.json()).error, /閲覧のみの権限では/);
});

test("API: 利用者以上が必要な書き込みの 403 は、英語の Forbidden ではなく writeForbidden（日本語の理由）で返す", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) await walk(rel);
      else if (e.name === "route.ts") files.push(rel);
    }
  };
  await walk("src/app/api");
  const offenders = [];
  for (const file of files) {
    const body = await readFile(path.join(ROOT, file), "utf8");
    // 使っているのに import が無いと、403 のはずが ReferenceError の 500 になる
    if (/writeForbidden\(\)/.test(body) && !/import \{[^}]*\bwriteForbidden\b[^}]*\} from "@\/lib\/write-guard"/.test(body)) {
      offenders.push(`${file}: writeForbidden を import していない`);
    }
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      // hasPermission(perm, "user") も hasPermission(await getCurrentPermission(), "user") も拾う
      if (!/hasPermission\(.*"user"\)/.test(line)) return;
      const window = lines.slice(i, i + 4).join("\n");
      if (/status: 403/.test(window) && !/writeForbidden\(\)/.test(window)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  const prep = await src("src/app/api/deals/[id]/preparation/route.ts");
  assert.doesNotMatch(prep, /"Forbidden: read-only"/);
});
