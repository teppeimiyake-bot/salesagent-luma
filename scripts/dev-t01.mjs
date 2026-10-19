// Local manual verification, using the actual T01 component, routes and development DB.
// Only this script's demo deal is exposed. Authentication is a fixed demo user.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { root, bundleT01Sources, connectDevelopment, newFixture, seedFixture, assertFixture, routeRequest } from "./lib/t01-development.mjs";

const compiled = await bundleT01Sources();
const output = path.join(root, ".verification/t01");
await mkdir(output, { recursive: true });
const fixtureFile = path.join(output, "demo.json");
let fixture;
try { fixture = JSON.parse(await readFile(fixtureFile, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const isNew = !fixture;
if (process.argv.includes("--cleanup") && isNew) throw Error("NO_DEMO_TO_CLEAN_UP");
fixture ??= newFixture();
const env = await connectDevelopment(compiled, fixture);
if (isNew) {
  await env.prisma.$transaction(tx => seedFixture(tx, fixture), { timeout: 30000 });
  await writeFile(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
}
await assertFixture(env.prisma, fixture);
if (process.argv.includes("--cleanup")) {
  await env.prisma.$transaction(async tx => {
    await tx.deal.delete({ where: { id: fixture.deal } });
    await tx.company.delete({ where: { id: fixture.company } });
    await tx.tenant.delete({ where: { id: fixture.tenant } });
  });
  await unlink(fixtureFile);
  await env.close();
  console.log("T01_DEMO_CLEANED_UP");
} else {
  const js = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/t01-preview.tsx"],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@": path.join(root, "src") }, define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "local-refresh", setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "local" }));
      builder.onLoad({ filter: /.*/, namespace: "local" }, () => ({
        contents: 'export const useRouter = () => ({refresh: () => window.dispatchEvent(new Event("t01:refresh"))});',
      }));
    } }],
  });
  const css = await postcss([tailwind({ base: root, optimize: false })]).process(`
    @import "tailwindcss" source(none);
    @source "./t01-preview.tsx";
    @source "../../src/components/deals/meeting-datetime-editor.tsx";
    @source "../../src/components/ui/datetime-input.tsx";
    @source "../../src/components/ui/button.tsx";
    body { background: #fafafa; font-family: sans-serif; }
  `, { from: path.join(root, "tests/fixtures/t01-preview.css") });
  const html = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T01 商談日時 | Luma 開発</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>';
  const port = 3005;
  const origin = `http://127.0.0.1:${port}`;
  const allowedOrigins = new Set([origin, `http://localhost:${port}`]);
  const pick = deal => Object.fromEntries(["id", "meetingStartAt", "meetingEndAt", "meetingScheduledAt"].map(key => [key, deal[key]]));
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, body, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (!allowedOrigins.has(`http://${req.headers.host}`) || req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
        send(403, { message: "Local requests only" }); return;
      }
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/") { send(200, html, "text/html; charset=utf-8"); return; }
      if (req.method === "GET" && url.pathname === "/app.js") { send(200, js.outputFiles[0].text, "text/javascript; charset=utf-8"); return; }
      if (req.method === "GET" && url.pathname === "/app.css") { send(200, css.css, "text/css; charset=utf-8"); return; }
      if (req.method === "GET" && ["/demo", `/api/deals/${fixture.deal}`].includes(url.pathname)) {
        const response = await routeRequest(env.route, fixture);
        const result = await response.json();
        send(response.status, result.deal ? { deal: pick(result.deal) } : result); return;
      }
      if (req.method === "PATCH" && url.pathname === `/api/deals/${fixture.deal}`) {
        if (!allowedOrigins.has(req.headers.origin) || !req.headers["content-type"]?.startsWith("application/json")) {
          send(403, { message: "Same-origin JSON required" }); return;
        }
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 4096) { send(413, { message: "Request too large" }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { send(400, { message: "Invalid JSON" }); return; }
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(key => !["meetingStartAt", "meetingEndAt"].includes(key))) {
          send(400, { message: "日時のみ編集できます。" }); return;
        }
        const response = await routeRequest(env.route, fixture, body);
        const result = await response.json();
        send(response.status, result.deal ? { deal: pick(result.deal) } : result); return;
      }
      send(404, { message: "Not found" });
    } catch {
      send(500, { message: "開発用DBとの通信に失敗しました。再試行してください。" });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`T01 development demo: ${origin}`));
  server.on("error", async () => { console.error("T01_LOCAL_SERVER_FAILED"); await env.close(); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    server.close(async () => { await env.close(); process.exit(0); });
  });
}
