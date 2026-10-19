import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertDevelopmentUploadMount,
  CloudDevelopmentConfigurationError,
  parseMountInfo,
  prepareCloudDevelopmentRuntime,
  startCloudDevelopmentRuntime,
  validateCloudDevelopmentEnvironment,
} from "../scripts/cloud-development-runtime.mjs";

const FIXTURE_SECRET = "fixture-only-secret-never-a-real-credential-001";
function environment(overrides = {}) {
  return {
    LUMA_DEPLOYMENT_ENV: "development",
    LUMA_DEVELOPMENT_PROJECT_ID: "luma-test-dev",
    GOOGLE_CLOUD_PROJECT: "luma-test-dev",
    K_SERVICE: "luma-platform-dev",
    LUMA_DEVELOPMENT_UPLOAD_BUCKET: "luma-uploads-dev",
    DATABASE_URL: "postgresql://test:fixture-password@db.example.invalid/luma_dev?sslmode=require",
    JWT_SECRET: FIXTURE_SECRET,
    TENANT_STRICT: "1",
    LUMA_CLOUD_AI_MODE: "off",
    NODE_ENV: "production",
    ...overrides,
  };
}

const MOUNTINFO = [
  "20 1 0:1 / / rw,relatime - overlay overlay rw",
  "42 20 0:52 / /app/uploads rw,nosuid,nodev,relatime shared:7 - fuse.gcsfuse luma-uploads-dev rw,user_id=0,group_id=0",
].join("\n");

function runtimeOptions(overrides = {}) {
  return {
    env: environment(),
    readFileImpl: async (name, encoding) => {
      assert.equal(name, "/proc/self/mountinfo");
      assert.equal(encoding, "utf8");
      return MOUNTINFO;
    },
    statImpl: async (name) => ({
      isDirectory: () => name === "/app/uploads",
      isFile: () => name === "/app/server.js",
    }),
    realpathImpl: async (name) => name,
    accessImpl: async (name, mode) => {
      assert.equal(name, "/app/uploads");
      assert.equal(mode, constants.R_OK | constants.W_OK | constants.X_OK);
    },
    ...overrides,
  };
}

test("accepts an explicit development target with optimized Node runtime", () => {
  assert.deepEqual(validateCloudDevelopmentEnvironment(environment()), {
    project: "luma-test-dev", service: "luma-platform-dev", bucket: "luma-uploads-dev", port: "8080",
  });
});

test("rejects missing required settings before reading mount metadata", async () => {
  for (const name of ["LUMA_DEPLOYMENT_ENV", "LUMA_DEVELOPMENT_PROJECT_ID", "GOOGLE_CLOUD_PROJECT",
    "K_SERVICE", "LUMA_DEVELOPMENT_UPLOAD_BUCKET", "DATABASE_URL", "JWT_SECRET", "TENANT_STRICT", "LUMA_CLOUD_AI_MODE"]) {
    const env = environment();
    delete env[name];
    await assert.rejects(prepareCloudDevelopmentRuntime(runtimeOptions({ env,
      readFileImpl: async () => assert.fail("must not read mount data for invalid environment"),
    })), CloudDevelopmentConfigurationError, name);
  }
});

test("rejects production labels, project mismatches, and non-development service/bucket", () => {
  const bad = [
    { LUMA_DEPLOYMENT_ENV: "production" },
    { GOOGLE_CLOUD_PROJECT: "luma-prod-dev", LUMA_DEVELOPMENT_PROJECT_ID: "luma-prod-dev" },
    { GOOGLE_CLOUD_PROJECT: "luma-production", LUMA_DEVELOPMENT_PROJECT_ID: "luma-production" },
    { GOOGLE_CLOUD_PROJECT: "luma-prod123", LUMA_DEVELOPMENT_PROJECT_ID: "luma-prod123" },
    { LUMA_DEVELOPMENT_PROJECT_ID: "another-project" },
    { GOOGLE_CLOUD_PROJECT: " luma-test-dev" },
    { GOOGLE_CLOUD_PROJECT: "123456789" },
    { K_SERVICE: "luma-platform" }, { K_SERVICE: "luma-prod-dev" },
    { LUMA_DEVELOPMENT_UPLOAD_BUCKET: "luma-production-dev" },
    { LUMA_DEVELOPMENT_UPLOAD_BUCKET: "luma-uploads" },
    { TENANT_STRICT: "0" },
  ];
  for (const overrides of bad) assert.throws(() => validateCloudDevelopmentEnvironment(environment(overrides)), CloudDevelopmentConfigurationError);
});

test("accepts the user-authorized shared project for a named verification service", async () => {
  const env = environment({ GOOGLE_CLOUD_PROJECT: "lumaagentlist", LUMA_DEVELOPMENT_PROJECT_ID: "lumaagentlist" });
  const prepared = await prepareCloudDevelopmentRuntime(runtimeOptions({ env }));
  assert.equal(prepared.project, "lumaagentlist");
  assert.equal(prepared.childEnv.LUMA_DEPLOYMENT_ENV, "development");
  assert.equal(prepared.childEnv.LUMA_CLOUD_AI_MODE, "off");
});

test("validates PostgreSQL URL without connecting or echoing credentials", () => {
  for (const DATABASE_URL of [
    "https://db.example.invalid", "postgresql://db.example.invalid/db",
    "postgresql://u:p@db.example.invalid/", "postgresql://u:p@production.example.invalid/db",
    "postgresql://u:p@db.example.invalid/production", "postgresql://u:p@db.example.invalid/db#fragment",
    "postgresql://u:LEAK-ME@db.example.invalid/db\n", "postgresql://u:LEAK-ME@/db",
  ]) {
    assert.throws(() => validateCloudDevelopmentEnvironment(environment({ DATABASE_URL })), (error) => {
      assert.equal(error.message, "DATABASE_URL must be a complete development PostgreSQL URL.");
      assert.ok(!error.message.includes("LEAK-ME"));
      return true;
    });
  }
  assert.doesNotThrow(() => validateCloudDevelopmentEnvironment(environment({ DATABASE_URL: "postgres://u:p@db.example.invalid/test" })));
});

test("rejects short or fallback JWT secrets and counts UTF-8 bytes", () => {
  for (const JWT_SECRET of ["short", " ".repeat(40), "dev-secret-change-me-please-32chars-minimum", " dev-secret-change-me-please-32chars-minimum ",
    "build-only-not-a-runtime-secret-00000000", " build-only-not-a-runtime-secret-00000000 "]) {
    assert.throws(() => validateCloudDevelopmentEnvironment(environment({ JWT_SECRET })), /JWT_SECRET/);
  }
  assert.doesNotThrow(() => validateCloudDevelopmentEnvironment(environment({ JWT_SECRET: "あ".repeat(11) })));
});

test("rejects platform selectors, even false-looking values used as truthy flags", () => {
  for (const name of ["VERCEL", "VERCEL_ENV", "AWS_LAMBDA_FUNCTION_NAME", "AWS_REGION", "BLOB_READ_WRITE_TOKEN", "FORCE_BLOB_STORAGE"]) {
    assert.throws(() => validateCloudDevelopmentEnvironment(environment({ [name]: "0" })), /Vercel, AWS, and Blob/);
  }
});

test("blocks every live AI provider path rather than assuming AI_PROVIDER=off disables Gemini", () => {
  for (const overrides of [
    { LUMA_CLOUD_AI_MODE: "vertex" }, { AI_PROVIDER: "off" }, { AI_PROVIDER: "vertex" },
    { AI_PROVIDER: "anthropic" }, { AI_PROVIDER_HEAVY: "anthropic" },
    ...["GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
      "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "VERTEX_AI_PROJECT",
      "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_OAUTH_ACCESS_TOKEN"].map((name) => ({ [name]: "LEAK-ME-AI" })),
    { GOOGLE_GENERATIVE_AI_API_KEY: " " },
  ]) {
    assert.throws(() => validateCloudDevelopmentEnvironment(environment(overrides)), (error) => {
      assert.ok(error instanceof CloudDevelopmentConfigurationError);
      assert.ok(!error.message.includes("LEAK-ME-AI"));
      return true;
    });
  }
});

test("rejects invalid ports", () => {
  for (const PORT of ["", "0", "65536", "8080x", "-1"]) {
    assert.throws(() => validateCloudDevelopmentEnvironment(environment({ PORT })), /PORT/);
  }
});

test("parses mountinfo optional fields and escaped paths", () => {
  const parsed = parseMountInfo("42 20 0:52 / /app/uploads\\040test rw shared:7 - fuse.gcsfuse luma-uploads-dev rw\nmalformed");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].mountPoint, "/app/uploads test");
  assert.equal(parsed[0].source, "luma-uploads-dev");
  assert.doesNotThrow(() => assertDevelopmentUploadMount(MOUNTINFO, "luma-uploads-dev"));
});

test("rejects plain directories, tmpfs, parent mounts, wrong buckets, read-only and stacked mounts", () => {
  for (const mountInfo of [
    "", "20 1 0:1 / / rw - overlay overlay rw", MOUNTINFO.replace("fuse.gcsfuse", "tmpfs"),
    MOUNTINFO.replace("/app/uploads ", "/app "), MOUNTINFO.replace("luma-uploads-dev", "another-bucket-dev"),
    MOUNTINFO.replace("rw,nosuid", "ro,nosuid"), MOUNTINFO.replace("rw,user_id", "ro,user_id"),
    `${MOUNTINFO}\n${MOUNTINFO.split("\n")[1]}`,
  ]) assert.throws(() => assertDevelopmentUploadMount(mountInfo, "luma-uploads-dev"), /writable GCS FUSE mount/);
});

test("rejects missing runtime metadata, a redirected mount or unavailable server, without leaking I/O errors", async () => {
  await assert.rejects(prepareCloudDevelopmentRuntime(runtimeOptions({
    readFileImpl: async () => { throw new Error("LEAK-ME-MOUNT-ERROR"); },
  })), /Linux mount information is unavailable/);
  await assert.rejects(prepareCloudDevelopmentRuntime(runtimeOptions({ realpathImpl: async () => "/tmp/uploads" })), /existing directory/);
  await assert.rejects(prepareCloudDevelopmentRuntime(runtimeOptions({ statImpl: async () => { throw new Error("LEAK-ME-SERVER-ERROR"); } })),
    (error) => error.message === "The upload mount or standalone Next.js server is unavailable.");
});

test("prepares the child with HTTPS-compatible optimized runtime and AI keyless Gemini, without mutating parent env", async () => {
  const env = environment({ HOSTNAME: "wrong-host", PORT: "9090", NODE_ENV: "development" });
  const before = { ...env };
  const config = await prepareCloudDevelopmentRuntime(runtimeOptions({ env }));
  assert.deepEqual(env, before);
  assert.equal(config.childEnv.HOSTNAME, "0.0.0.0");
  assert.equal(config.childEnv.NODE_ENV, "production");
  assert.equal(config.childEnv.PORT, "9090");
  assert.equal(config.childEnv.AI_PROVIDER, "gemini");
  assert.equal(config.childEnv.AI_PROVIDER_HEAVY, "gemini");
  assert.equal(config.childEnv.LUMA_CLOUD_AI_MODE, "off");
  assert.equal(config.childEnv.GOOGLE_GENERATIVE_AI_API_KEY, undefined);
  assert.equal(config.childEnv.LUMA_DEPLOYMENT_ENV, "development");
  assert.equal(config.childEnv.JWT_SECRET, FIXTURE_SECRET);
});

test("refuses a rw GCS mount that the non-root runtime user cannot access", async () => {
  let spawned = false;
  await assert.rejects(startCloudDevelopmentRuntime({ ...runtimeOptions({
    accessImpl: async (name, mode) => {
      assert.equal(name, "/app/uploads");
      assert.equal(mode, constants.R_OK | constants.W_OK | constants.X_OK);
      throw Object.assign(new Error("LEAK-ME-EACCES-DETAIL"), { code: "EACCES" });
    },
  }), spawnImpl: () => { spawned = true; } }),
  (error) => error.message === "The runtime user must have read, write, and directory access to /app/uploads.");
  assert.equal(spawned, false);
});

test("spawns only the fixed standalone server, forwards signals, preserves exit code and removes listeners", async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  const receivedSignals = [];
  child.kill = (signal) => receivedSignals.push(signal);
  let spawnCount = 0;
  const runtime = await startCloudDevelopmentRuntime({ ...runtimeOptions(), signals, execPath: "/test/node",
    spawnImpl: (command, args, options) => {
      spawnCount++;
      assert.equal(command, "/test/node");
      assert.deepEqual(args, ["/app/server.js"]);
      assert.equal(options.cwd, "/app");
      assert.equal(options.stdio, "inherit");
      assert.equal(options.env.PORT, "8080");
      assert.equal(options.env.HOSTNAME, "0.0.0.0");
      return child;
    },
  });
  assert.equal(spawnCount, 1);
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  assert.deepEqual(receivedSignals, ["SIGTERM", "SIGINT"]);
  child.emit("exit", 7, null);
  assert.deepEqual(await runtime.completion, { exitCode: 7, signal: null });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("an invalid environment cannot spawn, and child failure details stay private", async () => {
  await assert.rejects(startCloudDevelopmentRuntime({ ...runtimeOptions({ env: environment({ LUMA_CLOUD_AI_MODE: "on" }) }),
    spawnImpl: () => assert.fail("must never spawn"),
  }), /LUMA_CLOUD_AI_MODE/);
  const child = new EventEmitter();
  const signals = new EventEmitter();
  const runtime = await startCloudDevelopmentRuntime({ ...runtimeOptions(), signals, spawnImpl: () => child });
  child.emit("error", new Error("LEAK-ME-CHILD-ERROR"));
  await assert.rejects(runtime.completion, (error) => error.message === "The development standalone server failed to start.");
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("CLI startup failures contain no secret values", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/cloud-development-runtime.mjs", import.meta.url))], {
    encoding: "utf8", env: environment({ DATABASE_URL: "SECRET-DATABASE-VALUE", JWT_SECRET: "SECRET-JWT-VALUE" }),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /DATABASE_URL/);
  assert.ok(!result.stderr.includes("SECRET-DATABASE-VALUE"));
  assert.ok(!result.stderr.includes("SECRET-JWT-VALUE"));
});

test("Vertex mode only allows reviewed verification resources, model and budget", () => {
  const vertex = environment({ GOOGLE_CLOUD_PROJECT: "lumaagentlist", LUMA_DEVELOPMENT_PROJECT_ID: "lumaagentlist", K_SERVICE: "luma-platform-development", LUMA_DEVELOPMENT_UPLOAD_BUCKET: "lumaagentlist-luma-dev-uploads", LUMA_CLOUD_AI_MODE: "vertex", AI_PROVIDER: "vertex", AI_PROVIDER_HEAVY: "vertex", VERTEX_MODEL: "gemini-3.5-flash-lite", VERTEX_LOCATION: "global", LUMA_VERTEX_BUDGET_JPY: "25000" });
  assert.doesNotThrow(() => validateCloudDevelopmentEnvironment(vertex));
  for (const bad of [{ GOOGLE_CLOUD_PROJECT: "luma-test-dev", LUMA_DEVELOPMENT_PROJECT_ID: "luma-test-dev" }, { K_SERVICE: "sales-agent" }, { LUMA_DEVELOPMENT_UPLOAD_BUCKET: "luma-uploads-dev" }, { LUMA_CLOUD_AI_MODE: "off" }, { AI_PROVIDER_HEAVY: "gemini" }, { VERTEX_MODEL: "unpriced" }, { VERTEX_MODEL: "gemini-2.5-flash" }, { VERTEX_LOCATION: "asia-northeast1" }, ...["500", "1000", "2000", "25001", "30000"].map(LUMA_VERTEX_BUDGET_JPY => ({ LUMA_VERTEX_BUDGET_JPY })), { GOOGLE_APPLICATION_CREDENTIALS: "/secret.json" }, { VERTEX_API_KEY: "must-never-use" }]) {
    assert.throws(() => validateCloudDevelopmentEnvironment({ ...vertex, ...bad }), CloudDevelopmentConfigurationError);
  }
});
