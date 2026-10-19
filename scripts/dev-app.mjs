// Run the normal Next.js app locally with the confirmed development database.
// Keep configuration/client output separate from the older checkout and deployments.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import next from "next";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.execArgv.includes("--use-system-ca")) throw Error("Run with --use-system-ca");
if (process.env.NODE_ENV && process.env.NODE_ENV !== "development") throw Error("Development only");
const values = parse(await readFile(path.join(root, "../platform/.env")));
const url = new URL(values.DATABASE_URL);
if (!["postgresql:", "postgres:"].includes(url.protocol)
  || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/i.test(url.hostname)) {
  throw Error("Expected the user-confirmed development Neon database");
}
url.search = "";
url.hash = "";
url.searchParams.set("sslmode", "verify-full");

// Only DB/session values are taken from the existing development environment.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|GEMINI_|ANTHROPIC_|OPENAI_|NOTION_|BLOB_|AWS_|VERTEX_|CRON_|AUTH_|NEXTAUTH_|FEATURE_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: "development", DATABASE_URL: url.toString(),
  JWT_SECRET: values.JWT_SECRET || randomBytes(32).toString("hex"),
  FEATURE_MEET: "1", FEATURE_MEET_AUTO_RECORD: "1", FEATURE_AUTO_BANT: "1",
  FEATURE_PREPARATION_V2: "1", FEATURE_QUOTE_PDF_V2: "1", TENANT_STRICT: "1", NEXT_TELEMETRY_DISABLED: "1",
});

await mkdir(path.join(root, ".verification"), { recursive: true });
// This sparse development checkout has no deployment config. Generate a local-only
// config here because this Next.js version does not forward custom-server `conf`.
for (const name of ["next.config.ts", "next.config.js"]) {
  let exists = false;
  try { await access(path.join(root, name)); exists = true; } catch {}
  if (exists) throw Error("Expected the isolated development checkout without shared Next config");
}
const localConfig = 'export { default } from "./scripts/local-next-config.mjs";\n';
const configFile = path.join(root, "next.config.mjs");
let current;
try { current = await readFile(configFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (current !== undefined && current !== localConfig) throw Error("Refusing to overwrite an existing Next configuration");
await writeFile(configFile, localConfig);
const tsconfig = {
  extends: "../tsconfig.json",
  compilerOptions: { paths: { "@/*": ["../src/*"], "@prisma/client": ["./generated/client"] } },
  include: ["../next-env.d.ts", "../src/**/*.ts", "../src/**/*.tsx", "./next-app/types/**/*.ts", "./next-app/dev/types/**/*.ts"],
  exclude: ["../node_modules"],
};
await writeFile(path.join(root, ".verification/tsconfig.app.json"), JSON.stringify(tsconfig, null, 2));
const hostname = "127.0.0.1";
const port = 3003;
const app = next({ dev: true, dir: root, hostname, port, webpack: true });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((req, res) => {
  const origin = req.headers.origin;
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (!allowed.has(`http://${req.headers.host}`) || origin && !allowed.has(origin)) {
    res.writeHead(403); res.end("Local requests only"); return;
  }
  handle(req, res);
});
server.listen(port, hostname, () => console.log(`Luma development app: http://${hostname}:${port}/dashboard`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close(async () => { await app.close(); process.exit(0); });
});
