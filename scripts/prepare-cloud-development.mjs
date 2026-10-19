// Package only explicitly selected development sources. No cloud or DB access.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedSourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json", ".svg", ".ico", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ttf", ".otf"]);
// The SIL OFL text must ship next to the bundled PDF fonts; no other plain-text file is packaged.
const allowedLicenseFiles = new Set([path.join("src", "lib", "pdf", "fonts", "OFL.txt")]);

async function ordinaryFile(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Build input must be an ordinary file.");
  if (await realpath(file) !== path.resolve(file)) throw new Error("Symbolic links in input ancestors are not allowed.");
  return readFile(file);
}

async function createOutputParent(root) {
  let current = root;
  for (const name of [".verification", "cloud-development"]) {
    current = path.join(current, name);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error("Build output cannot have a symbolic link ancestor.");
    }
  }
  return current;
}

async function collectTree(root, rel, entries) {
  const stat = await lstat(path.join(root, rel));
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in build sources.");
  if (stat.isDirectory()) {
    for (const name of (await readdir(path.join(root, rel))).sort()) {
      if (name.startsWith(".") || /^(node_modules|uploads|secrets|credentials)$/i.test(name)) {
        throw new Error("Unexpected private or generated directory in build sources.");
      }
      await collectTree(root, path.join(rel, name), entries);
    }
  } else if (stat.isFile()) {
    if ((!allowedSourceExtensions.has(path.extname(rel)) && !allowedLicenseFiles.has(rel)) || /(^|\/)(credentials|service-account|secrets?)([.\/-]|$)/i.test(rel)) {
      throw new Error("Unexpected file type or credentials file in build sources.");
    }
    entries.set(rel, await ordinaryFile(path.join(root, rel)));
  } else {
    throw new Error("Unsupported build input.");
  }
}

export async function prepareCloudDevelopment(root = scriptRoot) {
  root = await realpath(root);
  // Keep sources, local generated clients and shared node_modules isolated.
  const entries = new Map();
  await collectTree(root, "src", entries);
  await collectTree(root, "public", entries);
  for (const file of ["package-lock.json", "prisma/schema.prisma", "postcss.config.mjs"]) {
    entries.set(file, await ordinaryFile(path.join(root, file)));
  }
  const pkg = JSON.parse(await ordinaryFile(path.join(root, "package.json")));
  const lock = JSON.parse(entries.get("package-lock.json"));
  if (Object.values(lock.packages ?? {}).some(p => p.link || (p.resolved && /^(?:file:|link:|\/|\.\.?\/)/.test(p.resolved)))) {
    throw new Error("Local or linked dependencies are not allowed in a cloud build.");
  }
  for (const kind of ["dependencies", "devDependencies"]) {
    const sorted = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    if (sorted(pkg[kind]) !== sorted(lock.packages?.[""]?.[kind])) {
      throw new Error("Development package and lockfile dependencies do not match.");
    }
  }
  entries.set("package.json", Buffer.from(JSON.stringify({
    name: pkg.name, version: pkg.version, private: true,
    scripts: { build: "next build --webpack" },
    dependencies: pkg.dependencies, devDependencies: pkg.devDependencies,
  }, null, 2) + "\n"));
  // Do not read or copy any existing deployment config or .env file.
  for (const [source, destination] of [
    ["scripts/cloud-development-next-config.mjs", "next.config.mjs"],
    ["scripts/cloud-development-runtime.mjs", "cloud-development-runtime.mjs"],
    ["scripts/cloud-development/Dockerfile", "Dockerfile"],
  ]) entries.set(destination, await ordinaryFile(path.join(root, source)));
  entries.set("tsconfig.json", Buffer.from(JSON.stringify({
    compilerOptions: {
      target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true,
      skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
      module: "esnext", moduleResolution: "bundler", resolveJsonModule: true,
      isolatedModules: true, jsx: "react-jsx", incremental: true,
      plugins: [{ name: "next" }], paths: { "@/*": ["./src/*"] },
    },
    include: ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2) + "\n"));
  const ignore = "node_modules\n.next\n.env*\n.git*\n.npm*\nuploads\n*.log\n";
  entries.set(".dockerignore", Buffer.from(ignore));
  entries.set(".gcloudignore", Buffer.from(ignore));
  const parent = await createOutputParent(root);
  const context = await mkdtemp(path.join(parent, "context-"));
  const files = [];
  for (const [file, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    await mkdir(path.dirname(path.join(context, file)), { recursive: true });
    await writeFile(path.join(context, file), bytes, { flag: "wx" });
    files.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
  await writeFile(path.join(context, "development-build-manifest.json"), JSON.stringify({
    environment: "development", cloudOperations: false, secretsIncluded: false, files,
  }, null, 2) + "\n", { flag: "wx" });
  return { context, fileCount: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareCloudDevelopment();
  console.log(JSON.stringify(result));
}
