import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareCloudDevelopment } from "../scripts/prepare-cloud-development.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "luma-dev-cloud-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = { name: "fixture", version: "0.0.0", dependencies: { next: "16.2.4" }, devDependencies: {} };
  const inputs = {
    "src/app/page.tsx": "export default function Page() { return null; }",
    "public/icon.svg": "<svg/>",
    "prisma/schema.prisma": "// fixture",
    "postcss.config.mjs": "export default {};",
    "package.json": JSON.stringify({ ...pkg, scripts: { postinstall: "DO_NOT_RUN", "db:seed": "DO_NOT_RUN" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": pkg } }),
    "scripts/cloud-development-next-config.mjs": "export default { output: 'standalone' };",
    "scripts/cloud-development-runtime.mjs": "// runtime fixture",
    "scripts/cloud-development/Dockerfile": "FROM fixture",
    ".env": "SECRET_MUST_NOT_APPEAR",
    ".env.local": "LOCAL_SECRET_MUST_NOT_APPEAR",
    "next.config.mjs": "DO_NOT_READ_EXISTING_CONFIG",
    "uploads/demo.txt": "EXISTING_DEMO_MUST_NOT_APPEAR",
    "node_modules/fake.js": "SHARED_DEPENDENCY_MUST_NOT_APPEAR",
    ".verification/cached-secret": "CACHED_SECRET_MUST_NOT_APPEAR",
  };
  for (const [rel, value] of Object.entries(inputs)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), value);
  }
  return root;
}

test("only selected sources are packaged; secrets, uploads and existing config are excluded", async t => {
  const root = await fixture(t);
  const { context, fileCount } = await prepareCloudDevelopment(root);
  const manifest = JSON.parse(await readFile(path.join(context, "development-build-manifest.json")));
  assert.equal(manifest.environment, "development");
  assert.equal(manifest.files.length, fileCount);
  const names = await readdir(context);
  for (const denied of [".env", ".env.local", "uploads", "node_modules", ".verification"]) assert.ok(!names.includes(denied));
  assert.match(await readFile(path.join(context, "next.config.mjs"), "utf8"), /standalone/);
  assert.deepEqual(JSON.parse(await readFile(path.join(context, "package.json"))).scripts, { build: "next build --webpack" });
  for (const file of manifest.files) {
    const contents = await readFile(path.join(context, file.path));
    assert.equal(file.sha256, createHash("sha256").update(contents).digest("hex"));
    assert.doesNotMatch(contents.toString(), /MUST_NOT_APPEAR|DO_NOT_RUN|DO_NOT_READ/);
  }
});

test("the PDF font license is packaged, other plain-text files in the sources are still refused", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "src/lib/pdf/fonts"), { recursive: true });
  await writeFile(path.join(root, "src/lib/pdf/fonts/OFL.txt"), "SIL Open Font License");
  const { context } = await prepareCloudDevelopment(root);
  assert.equal(await readFile(path.join(context, "src/lib/pdf/fonts/OFL.txt"), "utf8"), "SIL Open Font License");
  for (const rel of ["src/lib/pdf/notes.txt", "src/lib/pdf/fonts/README.txt", "src/OFL.txt"]) {
    await writeFile(path.join(root, rel), "plain text");
    await assert.rejects(prepareCloudDevelopment(root), /Unexpected file type/, rel);
    await rm(path.join(root, rel));
  }
});

test("each package is fresh, without stale generated or private files", async t => {
  const root = await fixture(t);
  const first = await prepareCloudDevelopment(root);
  await writeFile(path.join(first.context, ".env"), "must not carry over");
  const second = await prepareCloudDevelopment(root);
  assert.notEqual(second.context, first.context);
  assert.ok(!(await readdir(second.context)).includes(".env"));
});

test("symlinked sources cannot pull files from another checkout", async t => {
  const root = await fixture(t);
  await symlink(path.join(root, ".env"), path.join(root, "src/leaked.ts"));
  await assert.rejects(prepareCloudDevelopment(root), /Symbolic links/);
});

test("private files and credential JSON inside source trees are rejected", async t => {
  for (const name of [".env", "service-account.json", "credentials.json", "key.pem"]) {
    const root = await fixture(t);
    await writeFile(path.join(root, "src", name), "secret");
    await assert.rejects(prepareCloudDevelopment(root), /private|credentials|file type/);
  }
});

test("mismatched dependencies fail before creating a bundle", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "different" } }));
  await assert.rejects(prepareCloudDevelopment(root), /lockfile/);
});

test("output paths cannot redirect writes into another directory", async t => {
  const root = await fixture(t);
  await symlink(path.join(root, "uploads"), path.join(root, ".verification/cloud-development"));
  await assert.rejects(prepareCloudDevelopment(root), /symbolic link/);
});

test("symlinked parents of explicit inputs are rejected before reading", async t => {
  const root = await fixture(t);
  const elsewhere = await fixture(t);
  await rm(path.join(root, "prisma"), { recursive: true });
  await symlink(path.join(elsewhere, "prisma"), path.join(root, "prisma"));
  await assert.rejects(prepareCloudDevelopment(root), /Symbolic links in input ancestors/);
});

test("symlinked output ancestor cannot create anything in its target", async t => {
  const root = await fixture(t);
  await rm(path.join(root, ".verification"), { recursive: true });
  await symlink(path.join(root, "uploads"), path.join(root, ".verification"));
  const before = await readdir(path.join(root, "uploads"));
  await assert.rejects(prepareCloudDevelopment(root), /symbolic link ancestor/);
  assert.deepEqual(await readdir(path.join(root, "uploads")), before);
});

test("a lockfile cannot resolve dependencies from a local checkout", async t => {
  const root = await fixture(t);
  const file = path.join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(file));
  lock.packages["node_modules/next"] = { resolved: "file:../another-checkout" };
  await writeFile(file, JSON.stringify(lock));
  await assert.rejects(prepareCloudDevelopment(root), /Local or linked dependencies/);
});
