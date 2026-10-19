// The older checkout supplies shared dependencies. Install the two newer packages
// separately so local verification does not modify its node_modules or lockfile.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const output = path.join(root, ".verification/local-deps");
const dependencies = Object.fromEntries(["react-markdown", "googleapis"].map(name => {
  const version = lock.packages[`node_modules/${name}`]?.version;
  if (!version) throw Error(`Missing locked dependency: ${name}`);
  return [name, version];
}));
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "package.json"), JSON.stringify({ name: "luma-local-development-deps", private: true, dependencies }, null, 2));
let complete = true;
for (const [name, version] of Object.entries(dependencies)) {
  try {
    const installed = JSON.parse(await readFile(path.join(output, "node_modules", name, "package.json"), "utf8"));
    if (installed.version !== version) complete = false;
  } catch { complete = false; }
}
if (!complete) execFileSync("npm", ["install", "--prefix", output, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
console.log("Local development dependencies ready.");
