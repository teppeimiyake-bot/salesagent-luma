// Generate a separate development-test client without overwriting the app client.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".verification");
const schema = await readFile(path.join(root, "prisma/schema.prisma"), "utf8");
const match = schema.match(/generator\s+client\s*\{[^}]*\}/u);
if (!match || !/provider\s*=\s*"prisma-client-js"/u.test(match[0]) || /\boutput\s*=/u.test(match[0])) {
  throw new Error("Unexpected client generator configuration; isolated output cannot be guaranteed.");
}
const isolated = schema.replace(match[0], `${match[0].slice(0, -1)}  output = "./generated/client"\n}`);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "schema.prisma"), isolated);

// Client generation needs no live database or application secrets.
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"]
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, {
  DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/offline",
  PRISMA_GENERATE_SKIP_AUTOINSTALL: "1",
  CHECKPOINT_DISABLE: "1",
});
execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "generate", "--schema", path.join(output, "schema.prisma")], {
  cwd: output, env, stdio: "pipe",
});
await access(path.join(output, "generated/client/index.js"));
console.log("Development test client generated separately in .verification/generated/client.");
