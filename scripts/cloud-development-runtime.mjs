import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUD_APP_ROOT = "/app";
export const CLOUD_UPLOAD_MOUNT = "/app/uploads";
const SERVER_PATH = "/app/server.js";
const MOUNTINFO_PATH = "/proc/self/mountinfo";
const DISALLOWED_JWT_SECRETS = new Set([
  "dev-secret-change-me-please-32chars-minimum",
  "build-only-not-a-runtime-secret-00000000",
]);
const PRODUCTION_NAME = /(?:^|[-_.])(?:prod|production)(?:[-_.]|\d|$)/i;
const DEVELOPMENT_NAME = /(?:^|-)(?:dev|development)(?:-|$)/;
const AI_CREDENTIALS = new Set([
  "GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_OAUTH_ACCESS_TOKEN",
  "CLOUDSDK_AUTH_ACCESS_TOKEN", "GOOGLE_AUTH_TOKEN",
]);

/** Messages must contain configuration names only, never environment values. */
export class CloudDevelopmentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CloudDevelopmentConfigurationError";
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new CloudDevelopmentConfigurationError(message);
}

function configured(value) {
  // Mirrors !!process.env.KEY in src/lib/ai/provider.ts: whitespace is a key too.
  return value !== undefined && value !== "";
}

function validDatabaseUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || /[\u0000-\u0020]/.test(value)) return false;
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    return ["postgres:", "postgresql:"].includes(url.protocol)
      && Boolean(url.hostname && url.username && url.password && database)
      && !database.includes("/") && !url.hash
      && !PRODUCTION_NAME.test(url.hostname) && !PRODUCTION_NAME.test(database);
  } catch {
    return false;
  }
}

/** Pure validation. Does not read an env file, connect to a DB, or call Google. */
export function validateCloudDevelopmentEnvironment(env) {
  requireCondition(env.LUMA_DEPLOYMENT_ENV === "development", "LUMA_DEPLOYMENT_ENV must be development.");
  const project = env.GOOGLE_CLOUD_PROJECT;
  const expectedProject = env.LUMA_DEVELOPMENT_PROJECT_ID;
  requireCondition(typeof project === "string" && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)
    && !PRODUCTION_NAME.test(project),
  "GOOGLE_CLOUD_PROJECT must be a valid non-production project ID.");
  requireCondition(project === expectedProject, "LUMA_DEVELOPMENT_PROJECT_ID must exactly match GOOGLE_CLOUD_PROJECT.");

  const service = env.K_SERVICE;
  requireCondition(typeof service === "string" && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(service)
    && DEVELOPMENT_NAME.test(service) && !PRODUCTION_NAME.test(service), "K_SERVICE must be an explicitly named dev or development service.");
  const bucket = env.LUMA_DEVELOPMENT_UPLOAD_BUCKET;
  requireCondition(typeof bucket === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    && DEVELOPMENT_NAME.test(bucket) && !PRODUCTION_NAME.test(bucket), "LUMA_DEVELOPMENT_UPLOAD_BUCKET must be an explicitly named dev or development bucket.");

  requireCondition(validDatabaseUrl(env.DATABASE_URL), "DATABASE_URL must be a complete development PostgreSQL URL.");
  requireCondition(typeof env.JWT_SECRET === "string" && env.JWT_SECRET.trim().length > 0
    && Buffer.byteLength(env.JWT_SECRET, "utf8") >= 32
    && !DISALLOWED_JWT_SECRETS.has(env.JWT_SECRET.trim()), "JWT_SECRET must contain at least 32 bytes and must not use a known development or build-only fallback.");
  requireCondition(env.TENANT_STRICT === "1", "TENANT_STRICT must be 1.");

  const entries = Object.entries(env);
  requireCondition(!entries.some(([name, value]) => configured(value)
    && (/^(?:VERCEL(?:_|$)|AWS_|BLOB_)/.test(name) || name === "FORCE_BLOB_STORAGE")),
  "Vercel, AWS, and Blob environment settings are not allowed in this Cloud Run development runtime.");

  requireCondition(["off", "vertex"].includes(env.LUMA_CLOUD_AI_MODE), "LUMA_CLOUD_AI_MODE must be off or vertex.");
  // No API keys or local ADC key files, even when Vertex is enabled. Cloud Run uses its dedicated SA.
  requireCondition(!entries.some(([name, value]) => configured(value)
    && (AI_CREDENTIALS.has(name)
      || /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE_AI)_.*(?:KEY|TOKEN|CREDENTIALS|BASE_URL)$/.test(name))),
    "AI credentials must be absent; Vertex uses the dedicated Cloud Run service account.");
  if (env.LUMA_CLOUD_AI_MODE === "off") {
    requireCondition(["AI_PROVIDER", "AI_PROVIDER_HEAVY"].every(name => !configured(env[name]) || env[name] === "gemini"),
      "AI_PROVIDER and AI_PROVIDER_HEAVY must be absent or gemini while AI is disabled.");
    requireCondition(!entries.some(([name, value]) => configured(value) && /VERTEX/i.test(name)), "Vertex settings must be absent while AI is disabled.");
  } else {
    requireCondition(project === "lumaagentlist" && service === "luma-platform-development" && bucket === "lumaagentlist-luma-dev-uploads",
      "Vertex is limited to the explicitly authorized Luma verification resources.");
    requireCondition(env.AI_PROVIDER === "vertex" && env.AI_PROVIDER_HEAVY === "vertex" && env.VERTEX_LOCATION === "global"
      && env.VERTEX_MODEL === "gemini-3.5-flash-lite" && env.LUMA_VERTEX_BUDGET_JPY === "25000",
      "Vertex provider, location, model and guarded verification budget must match the reviewed policy.");
    requireCondition(!entries.some(([name, value]) => configured(value) && /VERTEX/i.test(name)
      && !["VERTEX_LOCATION", "VERTEX_MODEL", "LUMA_VERTEX_BUDGET_JPY"].includes(name)), "Unexpected Vertex configuration is not allowed.");
  }

  const port = env.PORT ?? "8080";
  requireCondition(typeof port === "string" && /^\d{1,5}$/.test(port)
    && Number(port) > 0 && Number(port) <= 65535, "PORT must be a valid TCP port.");
  return { project, service, bucket, port };
}

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Parse Linux mountinfo; optional fields are separated from FS fields by ' - '. */
export function parseMountInfo(text) {
  if (typeof text !== "string") return [];
  return text.split("\n").flatMap((line) => {
    const parts = line.trim().split(" - ");
    if (parts.length !== 2) return [];
    const left = parts[0].split(/\s+/);
    const right = parts[1].split(/\s+/);
    if (left.length < 6 || right.length < 3 || !/^\d+$/.test(left[0])) return [];
    return [{
      mountPoint: decodeMountField(left[4]),
      options: left[5].split(","),
      fsType: right[0],
      source: decodeMountField(right[1]),
      superOptions: right[2].split(","),
    }];
  });
}

export function assertDevelopmentUploadMount(mountInfo, bucket) {
  const matches = parseMountInfo(mountInfo).filter((mount) => mount.mountPoint === CLOUD_UPLOAD_MOUNT);
  // A directory on overlay/tmpfs, an ancestor mount, a bind mount from another
  // bucket, or an ambiguous stacked mount is not sufficient.
  requireCondition(matches.length === 1 && matches[0].fsType === "fuse.gcsfuse"
    && matches[0].source === bucket && matches[0].options.includes("rw")
    && !matches[0].options.includes("ro") && !matches[0].superOptions.includes("ro"),
  "A writable GCS FUSE mount for LUMA_DEVELOPMENT_UPLOAD_BUCKET is required at /app/uploads.");
}

/** Read only runtime metadata. All I/O is injectable for offline tests. */
export async function prepareCloudDevelopmentRuntime({
  env = process.env,
  readFileImpl = readFile,
  accessImpl = access,
  statImpl = stat,
  realpathImpl = realpath,
} = {}) {
  const config = validateCloudDevelopmentEnvironment(env);
  let mountInfo;
  try {
    mountInfo = await readFileImpl(MOUNTINFO_PATH, "utf8");
  } catch {
    throw new CloudDevelopmentConfigurationError("Linux mount information is unavailable; persistent storage cannot be verified.");
  }
  assertDevelopmentUploadMount(mountInfo, config.bucket);
  try {
    const [uploads, actualUploads, server] = await Promise.all([
      statImpl(CLOUD_UPLOAD_MOUNT), realpathImpl(CLOUD_UPLOAD_MOUNT), statImpl(SERVER_PATH),
    ]);
    requireCondition(uploads.isDirectory() && actualUploads === CLOUD_UPLOAD_MOUNT,
      "The verified upload mount must be an existing directory at /app/uploads.");
    requireCondition(server.isFile(), "The standalone Next.js server must exist at /app/server.js.");
  } catch (error) {
    if (error instanceof CloudDevelopmentConfigurationError) throw error;
    throw new CloudDevelopmentConfigurationError("The upload mount or standalone Next.js server is unavailable.");
  }
  try {
    // A rw mount alone is insufficient: the non-root runtime user also needs
    // directory permissions. Do not create a probe object in the bucket.
    await accessImpl(CLOUD_UPLOAD_MOUNT, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new CloudDevelopmentConfigurationError("The runtime user must have read, write, and directory access to /app/uploads.");
  }
  return {
    ...config,
    childEnv: {
      ...env,
      NODE_ENV: "production", // Next optimization mode, not the deployment environment.
      HOSTNAME: "0.0.0.0",
      PORT: config.port,
      AI_PROVIDER: env.LUMA_CLOUD_AI_MODE === "vertex" ? "vertex" : "gemini",
      AI_PROVIDER_HEAVY: env.LUMA_CLOUD_AI_MODE === "vertex" ? "vertex" : "gemini",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  };
}

/** Starts only when called. Importing this module never launches a server. */
export async function startCloudDevelopmentRuntime({
  spawnImpl = spawn,
  signals = process,
  execPath = process.execPath,
  ...options
} = {}) {
  const config = await prepareCloudDevelopmentRuntime(options);
  let child;
  try {
    child = spawnImpl(execPath, [SERVER_PATH], {
      cwd: CLOUD_APP_ROOT, env: config.childEnv, stdio: "inherit",
    });
  } catch {
    throw new CloudDevelopmentConfigurationError("Unable to start the development standalone server.");
  }
  const completion = new Promise((resolveExit, reject) => {
    const forwardTerm = () => child.kill("SIGTERM");
    const forwardInt = () => child.kill("SIGINT");
    const cleanup = () => {
      signals.off("SIGTERM", forwardTerm);
      signals.off("SIGINT", forwardInt);
    };
    signals.on("SIGTERM", forwardTerm);
    signals.on("SIGINT", forwardInt);
    child.once("error", () => {
      cleanup();
      reject(new CloudDevelopmentConfigurationError("The development standalone server failed to start."));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      const exitCode = code ?? (signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1);
      resolveExit({ exitCode, signal: signal ?? null });
    });
  });
  return { child, completion };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { completion } = await startCloudDevelopmentRuntime();
    process.exitCode = (await completion).exitCode;
  } catch (error) {
    const message = error instanceof CloudDevelopmentConfigurationError
      ? error.message : "Unexpected development runtime startup failure.";
    console.error(`[cloud-development-runtime] ${message}`);
    process.exitCode = 1;
  }
}
