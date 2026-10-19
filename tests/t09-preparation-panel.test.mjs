import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// T09 §3-4 生成中は進捗（リサーチ中→生成中）が表示される。
// On Cloud Run (no VERCEL) the POST runs the whole generation inline and returns
// only after 1-3 minutes, so the panel must poll the saved status while the POST
// is still running. The real panel runs here with a minimal hooks runtime, fake
// interval timers and a scripted API; React, the UI kit and icons are stubbed.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/components/deals/preparation-panel.tsx";

const lucideNames = /import\s*\{([^}]+)\}\s*from\s*"lucide-react"/.exec(readFileSync(path.join(ROOT, ENTRY), "utf8"))[1]
  .split(",").map((name) => name.trim()).filter(Boolean);
const element = (type) => `(props)=>({type:${JSON.stringify(type)},props})`;
const stubs = {
  react: ["useState", "useEffect", "useRef", "useCallback"]
    .map((hook) => `export const ${hook}=(...args)=>mocks.hooks.${hook}(...args);`).join(""),
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "react-markdown": `export default ${element("markdown")};`,
  "lucide-react": lucideNames.map((name) => `export const ${name}=()=>null;`).join(""),
  "@/components/ui/card": ["Card", "CardHeader", "CardTitle", "CardContent"].map((name) => `export const ${name}=${element(name)};`).join(""),
  "@/components/ui/button": `export const Button=${element("Button")};`,
  "@/components/ui/badge": `export const Badge=${element("Badge")};`,
};

const bundle = (await build({
  absWorkingDir: ROOT, entryPoints: [ENTRY], bundle: true, write: false, format: "cjs", platform: "neutral",
  jsx: "automatic", logLevel: "silent",
  plugins: [{ name: "t09-panel-stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
      if (a.path in stubs) return { path: a.path, namespace: "stub" };
      return { errors: [{ text: `Unexpected dependency of ${ENTRY}: ${a.path}` }] };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
})).outputFiles[0].text;

const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function expand(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { type: node.type, props: { ...node.props, children: expand(node.props?.children) } };
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

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
}

// One stateful component (PreparationV2Panel); its children are plain functions.
function mount(render) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let scheduled = false;
  let unmounted = false;
  let tree = null;
  const commit = () => {
    if (unmounted) return;
    cursor = 0;
    effects = [];
    tree = expand(render());
    for (const [i, effect, deps] of effects) {
      slots[i]?.cleanup?.();
      slots[i] = { deps, cleanup: effect() };
    }
  };
  const schedule = () => {
    if (scheduled || unmounted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      commit();
    });
  };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          const value = typeof next === "function" ? next(slot.value) : next;
          if (Object.is(value, slot.value)) return;
          slot.value = value;
          schedule();
        };
        slots[i] = slot;
      }
      return [slots[i].value, slots[i].set];
    },
    useRef(initial) {
      const i = cursor++;
      slots[i] ??= { current: initial };
      return slots[i];
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) effects.push([i, effect, deps]);
    },
  };
  return {
    hooks,
    start: commit,
    tree: () => tree,
    unmount() {
      unmounted = true;
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

const MINUTE = 60 * 1000;
function brief(id, status, minutesAgo, extra = {}) {
  return {
    id, status, error: null, interrupted: false,
    industry_summary: status === "done" ? `${id}の業界サマリー` : null,
    hiring_insights: null, pain_hypotheses: [], proposal_story: null, sources: [], model: null,
    created_at: new Date(Date.UTC(2026, 8, 30, 3, 0) - minutesAgo * MINUTE).toISOString(),
    disclaimer: "AIによる仮説です",
    ...extra,
  };
}

// The API as the panel sees it: GET reads the saved rows, POST stays open until
// the test answers it (the inline generation on Cloud Run).
function createServer(rows, { canCreate = true } = {}) {
  const server = {
    rows, canCreate, requests: [], posts: [], slowReads: false, heldReads: [],
    // late(url) true: the GET reads the rows when it arrives but answers only
    // when the test calls answer() on its lateHeld entry (a delayed response).
    late: null, lateHeld: [],
    set(id, status, extra = {}) {
      const row = server.rows.find((r) => r.id === id);
      Object.assign(row, { status }, status === "done" ? { industry_summary: `${id}の業界サマリー` } : {}, extra);
    },
    async fetch(url, init = {}) {
      const method = init.method ?? "GET";
      server.requests.push({ method, url: String(url), duringPost: server.posts.some((p) => !p.answered) });
      if (method === "POST") {
        return new Promise((resolve) => {
          const post = { answered: false };
          post.answer = (body, status = 202) => {
            post.answered = true;
            resolve(Response.json(body, { status }));
          };
          server.posts.push(post);
        });
      }
      if (server.slowReads) await new Promise((resolve) => server.heldReads.push(resolve));
      const newest = [...server.rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => ({ ...r }));
      const body = String(url).includes("history=1")
        ? { briefs: newest }
        : { brief: newest[0] ?? null, can_create: server.canCreate };
      if (server.late?.(String(url))) {
        await new Promise((answer) => server.lateHeld.push({ url: String(url), answer }));
      }
      return Response.json(body);
    },
    /** Answers the GETs held while slowReads was on (a slow Cloud Run / DB response). */
    releaseReads() {
      server.slowReads = false;
      for (const resolve of server.heldReads.splice(0)) resolve();
    },
  };
  return server;
}

async function renderPanel(server, { stage = "PROPOSAL" } = {}) {
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    setInterval: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  };
  const mocks = {};
  const loaded = { exports: {} };
  vm.runInNewContext(bundle, { module: loaded, exports: loaded.exports, mocks, window, fetch: (url, init) => server.fetch(url, init) });
  const { PreparationPanel } = loaded.exports;
  const runtime = mount(() => ({ type: PreparationPanel, props: { dealId: "deal", status: stage, preparationV2Enabled: true } }));
  mocks.hooks = runtime.hooks;
  runtime.start();
  await settle();
  const view = {
    timers,
    /** Fires every active interval once (1.5 s of polling) and lets the panel settle. */
    async tick() {
      for (const { fn } of [...timers.values()]) fn();
      await settle();
    },
    badges: () => findAll(runtime.tree(), (n) => n.type === "Badge").map(textOf),
    status: () => view.badges()[1],
    button: () => {
      const node = findAll(runtime.tree(), (n) => n.type === "Button")[0];
      return node && { label: textOf(node), disabled: node.props.disabled === true, click: node.props.onClick };
    },
    options: () => findAll(runtime.tree(), (n) => n.type === "option").map((n) => ({ value: n.props.value, text: textOf(n) })),
    select: async (id) => {
      findAll(runtime.tree(), (n) => n.type === "select")[0].props.onChange({ target: { value: id } });
      await settle();
    },
    text: () => textOf(runtime.tree()),
    tree: () => runtime.tree(),
    progressNote: () => findAll(runtime.tree(), (n) => n.props?.role === "status").map(textOf)[0] ?? null,
    unmount: () => runtime.unmount(),
  };
  return view;
}

test("T09 requester sees 準備中 → リサーチ中 → 生成中 → 完了 while the inline POST is still running", async () => {
  const server = createServer([brief("previous", "done", 24 * 60)]);
  const panel = await renderPanel(server);
  assert.equal(panel.status(), "完了");
  assert.deepEqual([panel.button().label, panel.button().disabled], ["再実行", false]);
  assert.equal(panel.timers.size, 0, "a finished brief is not polled");

  void panel.button().click();
  await settle();
  assert.equal(server.posts.length, 1);
  assert.equal(panel.status(), "準備中");
  assert.deepEqual([panel.button().label, panel.button().disabled], ["準備中", true]);
  assert.equal(panel.timers.size, 1, "polling starts as soon as the POST is sent");
  // The POST has not created the row yet; GET still returns yesterday's brief.
  await panel.tick();
  assert.equal(panel.status(), "準備中");
  assert.match(panel.text(), /previousの業界サマリー/);

  server.rows.push(brief("requested", "pending", 0));
  await panel.tick();
  assert.equal(panel.status(), "準備中");
  assert.equal(panel.progressNote(), "準備中です。完了すると業界サマリー・採用状況・課題仮説を表示します（1〜3分程度）。");
  assert.doesNotMatch(panel.text(), /確認できず|previousの業界サマリー/);
  assert.match(panel.options()[0].text, /^最新: .* \/ 準備中$/);

  server.set("requested", "researching");
  await panel.tick();
  assert.equal(panel.status(), "リサーチ中");
  assert.deepEqual([panel.button().label, panel.button().disabled], ["リサーチ中", true]);
  assert.match(panel.progressNote(), /^リサーチ中です。/);
  assert.match(panel.options()[0].text, / \/ リサーチ中$/);

  server.set("requested", "generating");
  await panel.tick();
  assert.equal(panel.status(), "生成中");
  assert.deepEqual([panel.button().label, panel.button().disabled], ["生成中", true]);
  assert.match(panel.progressNote(), /^生成中です。/);

  server.set("requested", "done");
  server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
  await settle();
  assert.equal(panel.status(), "完了");
  assert.deepEqual([panel.button().label, panel.button().disabled], ["再実行", false]);
  assert.equal(panel.progressNote(), null);
  assert.match(panel.text(), /requestedの業界サマリー/);
  assert.deepEqual(panel.options().map((o) => o.value), ["requested", "previous"]);
  assert.match(panel.options()[0].text, / \/ 完了$/);
  assert.equal(panel.timers.size, 0, "polling stops once the brief is finished");
  const latestReadsDuringPost = server.requests.filter((r) => r.method === "GET" && r.duringPost && !r.url.includes("history=1"));
  assert.ok(latestReadsDuringPost.length >= 4, `polled ${latestReadsDuringPost.length} times while the POST ran`);
  panel.unmount();
});

test("T09 each saved status has its own label, and pending is 準備中 rather than 生成中", async () => {
  const labels = { pending: "準備中", researching: "リサーチ中", generating: "生成中", done: "完了", error: "失敗" };
  for (const [status, label] of Object.entries(labels)) {
    const server = createServer([brief("latest", status, 1), brief("older", "done", 60)]);
    const panel = await renderPanel(server);
    assert.equal(panel.status(), label, status);
    assert.match(panel.options()[0].text, new RegExp(` / ${label}$`), status);
    const inProgress = ["pending", "researching", "generating"].includes(status);
    assert.deepEqual([panel.button().label, panel.button().disabled], inProgress ? [label, true] : ["再実行", false], status);
    assert.equal(panel.timers.size, inProgress ? 1 : 0, status);
    panel.unmount();
  }
});

test("T09 a slow status read is not overtaken by the next poll", async () => {
  const server = createServer([brief("running", "researching", 1)]);
  const panel = await renderPanel(server);
  server.slowReads = true;
  await panel.tick();
  await panel.tick();
  await panel.tick();
  const reads = () => server.requests.filter((r) => r.method === "GET" && !r.url.includes("history=1")).length;
  assert.equal(reads(), 2, "the initial read and one poll; later ticks wait for it");
  server.set("running", "generating");
  server.releaseReads();
  await settle();
  assert.equal(panel.status(), "生成中");
  await panel.tick();
  assert.equal(reads(), 3);
  panel.unmount();
});

test("T09 a refused POST stops the optimistic progress and shows the reason", async () => {
  const server = createServer([brief("previous", "done", 60)]);
  const panel = await renderPanel(server);
  void panel.button().click();
  await settle();
  await panel.tick();
  assert.equal(panel.status(), "準備中");
  server.posts[0].answer({ error: "Too many preparation briefs", message: "事前準備ブリーフの再生成は1案件1日3回までです。" }, 429);
  await settle();
  assert.equal(panel.status(), "完了");
  assert.deepEqual([panel.button().label, panel.button().disabled], ["再実行", false]);
  assert.match(panel.text(), /事前準備ブリーフの再生成は1案件1日3回までです。/);
  assert.match(panel.text(), /previousの業界サマリー/);
  assert.equal(panel.timers.size, 0);
  panel.unmount();
});

test("T09 an older brief picked during the generation stays selected when the POST returns", async () => {
  const server = createServer([brief("previous", "done", 60)]);
  const panel = await renderPanel(server);
  void panel.button().click();
  await settle();
  server.rows.push(brief("requested", "researching", 0));
  await panel.tick();
  assert.match(panel.progressNote(), /^リサーチ中です。/);

  // ③-13: the requester goes back to the previous generation while the new one runs.
  await panel.select("previous");
  server.set("requested", "generating");
  await panel.tick();
  assert.equal(panel.status(), "生成中");
  assert.match(panel.text(), /previousの業界サマリー/);
  assert.equal(panel.progressNote(), null);

  server.set("requested", "done");
  // Also while the panel's own read after the POST has not answered yet.
  server.late = () => true;
  server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
  await settle();
  assert.equal(panel.status(), "完了");
  assert.match(panel.text(), /previousの業界サマリー/);
  assert.doesNotMatch(panel.text(), /requestedの業界サマリー/);
  server.late = null;
  for (const read of server.lateHeld.splice(0)) read.answer();
  await settle();
  assert.equal(panel.status(), "完了");
  assert.match(panel.text(), /previousの業界サマリー/);
  assert.doesNotMatch(panel.text(), /requestedの業界サマリー/);
  assert.match(panel.options().find((o) => o.value === "requested").text, / \/ 完了$/);
  panel.unmount();
});

test("T09 a viewer reads the saved brief without a create button", async () => {
  const server = createServer([brief("saved", "done", 60)], { canCreate: false });
  const panel = await renderPanel(server);
  assert.equal(panel.button(), undefined);
  assert.equal(panel.status(), "完了");
  assert.match(panel.text(), /savedの業界サマリー/);
  assert.equal(server.requests.filter((r) => r.method === "POST").length, 0);
  panel.unmount();
});

test("T09 the create button is neither shown nor pressable until the first GET answers, for users and viewers", async () => {
  for (const canCreate of [true, false]) {
    const who = canCreate ? "user" : "viewer";
    const server = createServer([brief("previous", "done", 60)], { canCreate });
    server.slowReads = true;
    const panel = await renderPanel(server);
    // Before the answer the panel knows neither the permission nor the brief a
    // new request has to be told apart from (pressing it adopted that old brief).
    assert.equal(panel.button(), undefined, who);
    server.releaseReads();
    await settle();
    assert.equal(panel.status(), "完了", who);
    if (canCreate) assert.deepEqual([panel.button().label, panel.button().disabled], ["再実行", false]);
    else assert.equal(panel.button(), undefined, who);
    assert.equal(server.posts.length, 0, who);
    panel.unmount();
  }
});

// Up to the point where the POST has answered 完了 while two GETs are still on
// the way: a poll sent during 生成中, and the panel's own read after the POST.
async function postAnsweredWithLateReads() {
  const server = createServer([brief("previous", "done", 60)]);
  const panel = await renderPanel(server);
  void panel.button().click();
  await settle();
  server.rows.push(brief("requested", "researching", 0));
  await panel.tick();
  server.set("requested", "generating");
  server.late = () => true;
  await panel.tick();
  assert.equal(server.lateHeld.length, 1, "the poll that read 生成中 has not answered");
  assert.equal(panel.status(), "リサーチ中");

  server.set("requested", "done");
  server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
  await settle();
  server.late = null;
  assert.equal(server.lateHeld.length, 2, "the panel's read after the POST has not answered");
  const [stalePoll, readAfterPost] = server.lateHeld;
  return { server, panel, stalePoll, readAfterPost };
}

function assertDone(panel, when) {
  assert.equal(panel.status(), "完了", when);
  assert.equal(panel.progressNote(), null, when);
  assert.match(panel.text(), /requestedの業界サマリー/, when);
  assert.match(panel.options().find((o) => o.value === "requested").text, / \/ 完了$/, when);
}

test("T09 a status poll answered after the POST never takes 完了 back to 生成中", async () => {
  for (const order of ["stale poll first", "stale poll last"]) {
    const { panel, stalePoll, readAfterPost } = await postAnsweredWithLateReads();
    // The POST answer alone already shows 完了 in the badge, the body and the list.
    assertDone(panel, `${order}: POST answered`);
    const answers = order === "stale poll first" ? [stalePoll, readAfterPost] : [readAfterPost, stalePoll];
    for (const read of answers) {
      read.answer();
      await settle();
      assertDone(panel, `${order}: ${read === stalePoll ? "stale poll" : "read after POST"} answered`);
    }
    assert.deepEqual(panel.options().map((o) => o.value), ["requested", "previous"], order);
    assert.equal(panel.timers.size, 0, `${order}: polling stays stopped`);
    panel.unmount();
  }
});

test("T09 a history read sent during the generation and answered after the POST is dropped", async () => {
  for (const order of ["stale history first", "stale history last"]) {
    const server = createServer([brief("previous", "done", 60)]);
    const panel = await renderPanel(server);
    void panel.button().click();
    await settle();
    // The first sight of the requested brief re-reads the history; that read is slow.
    server.late = (url) => url.includes("history=1");
    server.rows.push(brief("requested", "researching", 0));
    await panel.tick();
    assert.match(panel.progressNote(), /^リサーチ中です。/);
    assert.equal(server.lateHeld.length, 1);

    server.set("requested", "done");
    server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
    await settle();
    server.late = null;
    assert.equal(server.lateHeld.length, 2, "the history read after the POST is slow too");
    const [staleHistory, historyAfterPost] = server.lateHeld;
    assert.equal(panel.status(), "完了", order);
    assert.match(panel.text(), /requestedの業界サマリー/, order);

    const answers = order === "stale history first" ? [staleHistory, historyAfterPost] : [historyAfterPost, staleHistory];
    for (const read of answers) {
      read.answer();
      await settle();
      assert.equal(panel.status(), "完了", order);
      assert.equal(panel.progressNote(), null, order);
      assert.match(panel.text(), /requestedの業界サマリー/, order);
    }
    assert.match(panel.options().find((o) => o.value === "requested").text, / \/ 完了$/, order);
    assert.equal(panel.timers.size, 0, order);
    panel.unmount();
  }
});

// On Vercel the POST answers 202 at once and the generation runs after it
// (after()); the panel keeps polling the saved status on its own.
async function postAnsweredAtOnce() {
  const server = createServer([brief("previous", "done", 24 * 60)]);
  const panel = await renderPanel(server);
  void panel.button().click();
  await settle();
  server.rows.push(brief("requested", "pending", 0));
  server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
  await settle();
  assert.equal(panel.status(), "準備中");
  assert.deepEqual(panel.options().map((o) => o.value), ["requested", "previous"]);
  assert.equal(panel.timers.size, 1, "still polling after the POST answered");
  return { server, panel };
}

test("T09 when the POST answers at once, polling follows the brief and re-reads the history when it finishes", async () => {
  const { server, panel } = await postAnsweredAtOnce();
  const historyReads = () => server.requests.filter((r) => r.url.includes("history=1")).length;
  const readsAfterPost = historyReads();
  server.set("requested", "researching");
  await panel.tick();
  assert.equal(panel.status(), "リサーチ中");
  server.set("requested", "generating");
  await panel.tick();
  assert.equal(panel.status(), "生成中");
  assert.match(panel.progressNote(), /^生成中です。/);
  assert.equal(historyReads(), readsAfterPost, "the list is not re-read while in progress");

  server.set("requested", "done");
  await panel.tick();
  // Re-read once on completion, so rows saved or changed by others meanwhile show up.
  assert.equal(historyReads(), readsAfterPost + 1);
  assertDone(panel, "finished");
  assert.equal(panel.timers.size, 0);
  panel.unmount();
});

test("T09 after the POST has answered, an older brief picked while polling stays selected (③-13)", async () => {
  const { server, panel } = await postAnsweredAtOnce();
  assert.match(panel.progressNote(), /^準備中です。/);
  await panel.select("previous");
  server.set("requested", "researching");
  await panel.tick();
  assert.equal(panel.status(), "リサーチ中");
  assert.match(panel.text(), /previousの業界サマリー/);
  assert.equal(panel.progressNote(), null);

  server.set("requested", "done");
  await panel.tick();
  assert.equal(panel.status(), "完了");
  assert.match(panel.text(), /previousの業界サマリー/);
  assert.doesNotMatch(panel.text(), /requestedの業界サマリー/);
  assert.match(panel.options().find((o) => o.value === "requested").text, / \/ 完了$/);
  panel.unmount();
});

test("T09 when the POST answers at once, a slow read of the panel's own is not applied over a newer poll", async () => {
  for (const slow of ["latest", "history"]) {
    const server = createServer([brief("previous", "done", 24 * 60)]);
    const panel = await renderPanel(server);
    void panel.button().click();
    await settle();
    server.rows.push(brief("requested", "pending", 0));
    // The panel's read right after the POST (of the latest brief, or of the history) is slow.
    server.late = slow === "latest" ? () => true : (url) => url.includes("history=1");
    server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
    await settle();
    server.late = null;
    assert.equal(server.lateHeld.length, 1, slow);
    assert.equal(panel.status(), "準備中", slow);

    // Meanwhile a poll reads リサーチ中 and answers first.
    server.set("requested", "researching");
    await panel.tick();
    assert.equal(panel.status(), "リサーチ中", slow);
    assert.match(panel.progressNote(), /^リサーチ中です。/, slow);

    // The slow read answers with 準備中; it must not take the display back.
    server.lateHeld[0].answer();
    await settle();
    assert.equal(panel.status(), "リサーチ中", slow);
    assert.match(panel.progressNote(), /^リサーチ中です。/, slow);
    assert.match(panel.options().find((o) => o.value === "requested").text, / \/ リサーチ中$/, slow);

    server.set("requested", "done");
    await panel.tick();
    assertDone(panel, slow);
    assert.equal(panel.timers.size, 0, slow);
    panel.unmount();
  }
});

test("T09 pressing the button while the first history read is still on the way keeps the new request shown", async () => {
  const server = createServer([brief("previous", "done", 60)]);
  // The button appears with the first latest-brief answer; the history is slow.
  server.late = (url) => url.includes("history=1");
  const panel = await renderPanel(server);
  assert.equal(server.lateHeld.length, 1);
  assert.deepEqual([panel.button().label, panel.button().disabled], ["再実行", false]);

  void panel.button().click();
  await settle();
  server.late = null;
  server.rows.push(brief("requested", "pending", 0));
  server.posts[0].answer({ brief: { ...server.rows[1] }, accepted: true });
  await settle();
  assert.equal(panel.status(), "準備中");
  assert.match(panel.progressNote(), /^準備中です。/);

  // The first history (without the new brief) answers last and is dropped.
  server.lateHeld[0].answer();
  await settle();
  assert.equal(panel.status(), "準備中");
  assert.match(panel.progressNote(), /^準備中です。/);
  assert.deepEqual(panel.options().map((o) => o.value), ["requested", "previous"]);
  assert.doesNotMatch(panel.text(), /失敗しました|undefined/);
  panel.unmount();
});

// PREP-B2: before the first reads answer, the panel does not know whether a brief exists.
test("T09 until the first reads answer the panel shows 読み込み中, not 未作成 / 保存済みブリーフはありません", async () => {
  for (const rows of [[brief("saved", "done", 60)], []]) {
    const exists = rows.length > 0;
    const server = createServer(rows);
    server.slowReads = true;
    const panel = await renderPanel(server);
    assert.equal(panel.status(), "読み込み中");
    assert.doesNotMatch(panel.text(), /未作成|保存済みブリーフはありません/);
    assert.match(panel.progressNote(), /保存済みブリーフを読み込んでいます/);
    server.releaseReads();
    await settle();
    assert.equal(panel.status(), exists ? "完了" : "未作成");
    assert.equal(/保存済みブリーフはありません/.test(panel.text()), !exists);
    assert.equal(panel.progressNote(), null);
    panel.unmount();
  }
});

test("T09 a failed first read shows the error, not 未作成", async () => {
  const server = createServer([brief("saved", "done", 60)]);
  const fetchRows = server.fetch;
  server.fetch = async (url, init) => (server.requests.length === 0 ? (server.requests.push({ method: "GET", url }), new Response("{}", { status: 500 })) : fetchRows(url, init));
  const panel = await renderPanel(server);
  assert.match(panel.text(), /事前準備の取得に失敗しました/);
  assert.doesNotMatch(panel.text(), /未作成|保存済みブリーフはありません|読み込んでいます/);
  assert.equal(panel.status(), "取得失敗");
  panel.unmount();
});

// PREP-B5: the header (latest read) and the body (history read, sent after it) used to show
// different statuses when the brief moved on between the two reads.
test("T09 reopening during a generation never shows リサーチ中 in the header while the body says 生成中", async () => {
  const server = createServer([brief("running", "researching", 1)]);
  server.late = () => true;
  const panel = await renderPanel(server);
  assert.equal(server.lateHeld.length, 1, "the latest read is on the way");
  server.set("running", "generating");
  server.lateHeld[0].answer();
  await settle();
  assert.equal(server.lateHeld.length, 2, "the history read (already 生成中) is on the way");
  // The latest read said リサーチ中 but the body is not loaded yet: nothing contradicts.
  const header = panel.status();
  const note = panel.progressNote() ?? "";
  assert.ok(header === "読み込み中" || note.startsWith(header), `${header} / ${note}`);
  server.late = null;
  server.lateHeld[1].answer();
  await settle();
  assert.equal(panel.status(), "生成中");
  assert.match(panel.progressNote(), /^生成中です。/);
  assert.match(panel.options()[0].text, / \/ 生成中$/);
  assert.deepEqual([panel.button().label, panel.button().disabled], ["生成中", true]);
  panel.unmount();
});

const classesOf = (node) => String(node?.props?.className ?? "").split(/\s+/);
// PREP-B3/B4: badges must not shrink into one character per line, and the title is not truncated at 390px.
test("T09 badges keep their text on one line and the title is not truncated", async () => {
  const server = createServer([brief("saved", "done", 60, {
    pain_hypotheses: [{ hypothesis: "とても長い仮説文".repeat(20), confidence: "low", evidence: "出典なしの仮説: 根拠", source_url: "" }],
  })]);
  const panel = await renderPanel(server);
  // Rendered in a test harness, so walk the tree directly.
  const tree = panel.tree();
  const badges = findAll(tree, (n) => n.type === "Badge");
  assert.deepEqual(badges.map(textOf), ["PROPOSAL", "完了", "確度:低"]);
  for (const badge of badges) {
    assert.ok(classesOf(badge).includes("shrink-0"), `${textOf(badge)} shrink-0`);
    assert.ok(classesOf(badge).includes("whitespace-nowrap"), `${textOf(badge)} whitespace-nowrap`);
  }
  const title = findAll(tree, (n) => n.type === "span" && textOf(n) === "事前準備ブリーフ")[0];
  assert.ok(title, "title span");
  assert.ok(!classesOf(title).includes("truncate"), "the title is not cut to 事…");
  assert.ok(classesOf(title).includes("whitespace-nowrap"));
  const cardTitle = findAll(tree, (n) => n.type === "CardTitle")[0];
  assert.ok(classesOf(cardTitle).includes("flex-wrap"), "the buttons move to the next line on a narrow screen");
  panel.unmount();
});
