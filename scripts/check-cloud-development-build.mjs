// Local isolated build; never uses gcloud, application credentials, or a live DB.
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareCloudDevelopment } from "./prepare-cloud-development.mjs";

const { context, fileCount } = await prepareCloudDevelopment();
console.log(`Checking ${fileCount} development inputs in ${context}`);
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const npmUserConfig = path.join(context, ".npm-user-empty");
const npmGlobalConfig = path.join(context, ".npm-global-empty");
await writeFile(npmUserConfig, "");
await writeFile(npmGlobalConfig, "");
Object.assign(env, {
  NODE_OPTIONS: "--use-system-ca",
  npm_config_userconfig: npmUserConfig, npm_config_globalconfig: npmGlobalConfig,
  npm_config_cache: path.join(context, ".npm-cache"),
  LUMA_DEPLOYMENT_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
  CHECKPOINT_DISABLE: "1", PRISMA_GENERATE_SKIP_AUTOINSTALL: "1",
  DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/offline",
  JWT_SECRET: "build-only-not-a-runtime-secret-00000000", TENANT_STRICT: "1",
});
for (const [command, args] of [
  ["npm", ["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]],
  [process.execPath, ["node_modules/prisma/build/index.js", "generate"]],
  ["npm", ["run", "build"]],
]) {
  const result = spawnSync(command, args, { cwd: context, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error("Development cloud build check failed; no cloud operations were performed.");
    process.exit(result.status || 1);
  }
}
console.log(`Development standalone build passed: ${context}`);
