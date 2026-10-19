import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// A small offline runtime for one client component: React hooks are reimplemented
// (state per component instance, effects after each render, re-render in a microtask),
// the UI kit and icons become plain elements, and every fetch goes to the test.
// Clicking a handler twice without awaiting reproduces "two clicks in the same event"
// (QG26-10): React has not re-rendered, so the disabled prop is still the old one.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

const HOOKS = ["useState", "useRef", "useEffect", "useLayoutEffect", "useCallback", "useMemo", "useId", "useTransition"];
const ESM_STUBS = {
  react: HOOKS.map((hook) => `export const ${hook}=(...args)=>globalThis.__hooks.${hook}(...args);`).join("") + "export default {};",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;",
  "next/navigation": "export const useRouter=()=>globalThis.__router;export const usePathname=()=>'/';export const useSearchParams=()=>new URLSearchParams();",
  "react-markdown": "export default (props)=>({type:'markdown',props});",
};
// Any named import resolves to an element factory named after it (Button, Card, Sparkles...).
const ELEMENT_STUB = "module.exports=Object.create(new Proxy({}, {get(_, name){"
  + "if (typeof name !== 'string' || name === '__esModule' || name === 'then') return undefined;"
  + "return (props)=>({type:name,props});}}));";
const isElementStub = (p) => p === "lucide-react" || p.startsWith("@/components/ui/") || p.startsWith("@radix-ui/");

export async function loadComponent(entry) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
    jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "component-stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.path in ESM_STUBS) return { path: a.path, namespace: "esm-stub" };
        if (isElementStub(a.path)) return { path: a.path, namespace: "element-stub" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "esm-stub" }, (a) => ({ contents: ESM_STUBS[a.path], loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "element-stub" }, () => ({ contents: ELEMENT_STUB, loader: "js" }));
    } }],
  });
  return result.outputFiles[0].text;
}

const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Renders `exportName` from the bundle with props. `respond(request)` answers each
 * fetch; returning undefined keeps the request open until request.answer() is called.
 */
export function mountComponent(bundle, exportName, props, respond = () => undefined) {
  const instances = new Map();
  const requests = [];
  let current = null;
  let effects = [];
  let scheduled = false;
  let tree = null;
  let idCounter = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const slot = () => {
    const i = current.cursor++;
    return [current.slots, i];
  };
  const hooks = {
    useState(initial) {
      const [slots, i] = slot();
      if (!slots[i]) {
        const state = { value: typeof initial === "function" ? initial() : initial };
        state.set = (next) => {
          const value = typeof next === "function" ? next(state.value) : next;
          if (Object.is(value, state.value)) return;
          state.value = value;
          schedule();
        };
        slots[i] = state;
      }
      return [slots[i].value, slots[i].set];
    },
    useRef(initial) {
      const [slots, i] = slot();
      slots[i] ??= { current: initial };
      return slots[i];
    },
    useCallback(fn, deps) {
      const [slots, i] = slot();
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: fn, deps };
      return slots[i].value;
    },
    useMemo(fn, deps) {
      const [slots, i] = slot();
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useEffect(effect, deps) {
      const [slots, i] = slot();
      if (!slots[i] || !deps || !sameDeps(slots[i].deps, deps)) effects.push([slots, i, effect, deps]);
    },
    useLayoutEffect(effect, deps) {
      hooks.useEffect(effect, deps);
    },
    useId() {
      const [slots, i] = slot();
      slots[i] ??= { value: `:r${idCounter++}:` };
      return slots[i].value;
    },
    useTransition() {
      return [false, (fn) => { void fn(); }];
    },
  };

  function expand(node, key) {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${key}.${child?.key ?? i}`));
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const id = `${key}:${node.type.name || "anonymous"}`;
      const instance = instances.get(id) ?? { slots: [] };
      instances.set(id, instance);
      const parent = current;
      current = { slots: instance.slots, cursor: 0 };
      try {
        return expand(node.type(node.props ?? {}), id);
      } finally {
        current = parent;
      }
    }
    return { type: node.type, props: { ...node.props, children: expand(node.props?.children, `${key}/${String(node.type)}`) } };
  }

  const timers = [];
  const fakeWindow = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    open() {},
    confirm: () => true,
    location: { href: "http://offline.invalid/" },
  };
  const fetchMock = (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? "GET", body: init.body };
    requests.push(request);
    const answer = respond(request);
    if (answer !== undefined) return Promise.resolve(answer);
    return new Promise((resolve) => {
      request.answer = (body, status = 200) => resolve(Response.json(body, { status }));
    });
  };
  const router = { refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} };
  const context = {
    module: { exports: {} }, exports: {}, require: (name) => require(name),
    fetch: fetchMock, window: fakeWindow, document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    setTimeout: fakeWindow.setTimeout, clearTimeout() {}, setInterval: fakeWindow.setInterval, clearInterval() {},
    queueMicrotask, console: { log() {}, warn() {}, error() {}, info() {} },
    confirm: () => true, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    Date, Intl, URL, URLSearchParams, Response, Request, Headers, Blob, File, FormData, Promise, Error, TextEncoder, TextDecoder,
    __router: router,
  };
  context.globalThis = context;
  context.__hooks = hooks;
  vm.runInNewContext(bundle, context);
  const Component = context.module.exports[exportName];
  if (typeof Component !== "function") throw Error(`${exportName} is not exported`);

  function render() {
    effects = [];
    tree = expand({ type: Component, props }, "root");
    const pending = effects;
    effects = [];
    for (const [slots, i, effect, deps] of pending) {
      slots[i]?.cleanup?.();
      const cleanup = effect();
      slots[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    }
  }
  render();
  return {
    requests,
    tree: () => tree,
    async settle() {
      for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

export function findAll(node, match, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (match(node)) found.push(node);
  return findAll(node.props?.children, match, found);
}

export function textOf(node) {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
}

/** The first element with an onClick whose text or aria-label contains `label`. */
export function clickable(tree, label) {
  const found = findAll(tree, (node) => typeof node.props?.onClick === "function"
    && (textOf(node).includes(label) || node.props["aria-label"] === label));
  if (!found.length) throw Error(`No clickable element labeled ${label}`);
  return found[0];
}
