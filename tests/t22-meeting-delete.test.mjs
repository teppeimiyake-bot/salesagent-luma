// T22/T04: 商談記録の削除で、録音（単一ファイル／分割アップロードのパート一式）と文字起こしの作業フォルダも消す。
// 実ファイルは一時フォルダに作り、DB・認証・テナント・Blob はモックにする。外部通信は使わない。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offlineModule } from "./helpers/offline-module.mjs";

const MEETING = "00000000-0000-4000-8000-00000000a001";
const OTHER_MEETING = "00000000-0000-4000-8000-00000000a002";
const UPLOAD = "11111111-1111-4111-8111-111111111111";
const OTHER_UPLOAD = "22222222-2222-4222-8222-222222222222";
const PARTS_KEY = `/uploads/recordings/parts/${UPLOAD}/manifest.json`;
const SINGLE_KEY = "/uploads/recordings/1790000000000_abc123.mp3";
const entry = "src/app/api/meetings/[id]/route.ts";

async function deleteRoute(t, { rows, ...overrides } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t22-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const m = {
    root, session: { userId: "user-1" }, permission: "user", tenant: { tenantId: "t1", crossTenant: false },
    rows: rows ?? [], log: [], deleteError: null, countError: null, deleteFileError: null,
    localPath: key => key?.startsWith("/uploads/") ? path.join(root, key.slice("/uploads/".length)) : null,
    ...overrides,
  };
  m.deleteFile = async key => {
    m.log.push(["deleteFile", key]);
    if (m.deleteFileError) throw m.deleteFileError;
    const file = m.localPath(key);
    if (file) await rm(file, { force: true });
  };
  m.prisma = {
    user: { findUnique: async () => ({ permission: m.permission }) },
    meeting: {
      findUnique: async ({ where, select }) => {
        m.log.push(["findUnique", where.id]);
        const row = m.rows.find(r => r.id === where.id);
        return row ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : null;
      },
      delete: async ({ where }) => {
        m.log.push(["delete", where.id]);
        if (m.deleteError) throw m.deleteError;
        m.rows = m.rows.filter(r => r.id !== where.id);
        return {};
      },
      count: async ({ where }) => {
        m.log.push(["count", where.recordingUrl]);
        if (m.countError) throw m.countError;
        return m.rows.filter(r => r.recordingUrl === where.recordingUrl).length;
      },
    },
  };
  const route = await offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);",
    "@/lib/feature-flags": "export const isAutoBantFeatureEnabled=()=>false;",
    "@/lib/ai/summarize-bant": "export const scheduleMeetingBantRefresh=async()=>{};",
    "@/lib/storage": "export const localStoragePath=k=>mocks.localPath(k);export const deleteFile=k=>mocks.deleteFile(k);",
    "@/lib/tenant-context": "export const getRequestTenant=async()=>mocks.tenant;",
  }, [entry, "src/lib/meetings/upload-sessions.ts", "src/lib/meetings/transcription-files.ts"],
  ["next/server", "zod", "node:fs/promises", "node:path"]);
  return {
    m,
    remove: id => route.DELETE(new Request("http://offline.invalid", { method: "DELETE" }), { params: Promise.resolve({ id }) }),
    put: async (key, body = "x") => {
      const file = m.localPath(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
      return file;
    },
    exists: key => stat(m.localPath(key)).then(() => true, () => false),
  };
}

const partsFiles = upload => ["manifest.json", "part-00000", "part-00001", "complete.lock"]
  .map(name => `/uploads/recordings/parts/${upload}/${name}`);
const workDir = id => `/uploads/recordings/segments/${id}`;

test("T22 delete: a split upload's parts folder and the transcription work folder are removed after the row", async t => {
  const { m, remove, put, exists } = await deleteRoute(t, { rows: [{ id: MEETING, recordingUrl: PARTS_KEY }] });
  for (const key of [...partsFiles(UPLOAD), ...partsFiles(OTHER_UPLOAD), `${workDir(MEETING)}/normalized.mp3`, `${workDir(OTHER_MEETING)}/normalized.mp3`]) await put(key);
  const res = await remove(MEETING);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(m.rows.length, 0);
  // The DB row goes first; the files are only touched once it is gone.
  assert.deepEqual(m.log, [["findUnique", MEETING], ["delete", MEETING], ["count", PARTS_KEY]]);
  assert.equal(await exists(`/uploads/recordings/parts/${UPLOAD}`), false, "parts, manifest and lock are removed");
  assert.equal(await exists(workDir(MEETING)), false, "normalized audio and segments are removed");
  // Other uploads and other meetings' work folders stay.
  for (const key of partsFiles(OTHER_UPLOAD)) assert.equal(await exists(key), true, key);
  assert.equal(await exists(`${workDir(OTHER_MEETING)}/normalized.mp3`), true);
});

test("T22 delete: a single recording file is deleted through storage", async t => {
  const { m, remove, put, exists } = await deleteRoute(t, { rows: [{ id: MEETING, recordingUrl: SINGLE_KEY }] });
  await put(SINGLE_KEY);
  await put(`${workDir(MEETING)}/normalized.mp3`);
  assert.equal((await remove(MEETING)).status, 200);
  assert.deepEqual(m.log, [["findUnique", MEETING], ["delete", MEETING], ["count", SINGLE_KEY], ["deleteFile", SINGLE_KEY]]);
  assert.equal(await exists(SINGLE_KEY), false);
  assert.equal(await exists(workDir(MEETING)), false);
});

test("T22 delete: a recording key still referenced by another meeting is kept", async t => {
  for (const key of [PARTS_KEY, SINGLE_KEY]) {
    const { m, remove, put, exists } = await deleteRoute(t, {
      rows: [{ id: MEETING, recordingUrl: key }, { id: OTHER_MEETING, recordingUrl: key }],
    });
    for (const file of key === PARTS_KEY ? partsFiles(UPLOAD) : [key]) await put(file);
    await put(`${workDir(MEETING)}/normalized.mp3`);
    assert.equal((await remove(MEETING)).status, 200);
    assert.deepEqual(m.rows.map(r => r.id), [OTHER_MEETING]);
    assert.equal(m.log.some(([op]) => op === "deleteFile"), false, key);
    assert.equal(await exists(key), true, key);
    // The work folder belongs to the deleted meeting only.
    assert.equal(await exists(workDir(MEETING)), false);
  }
});

test("T22 delete: a meeting without a recording only removes its work folder", async t => {
  const { m, remove, put, exists } = await deleteRoute(t, { rows: [{ id: MEETING, recordingUrl: null }] });
  await put(`${workDir(MEETING)}/segment-000.mp3`);
  assert.equal((await remove(MEETING)).status, 200);
  assert.deepEqual(m.log, [["findUnique", MEETING], ["delete", MEETING]]);
  assert.equal(await exists(workDir(MEETING)), false);
});

test("T22 delete: a missing meeting is 404 and nothing is deleted", async t => {
  const { m, remove, put, exists } = await deleteRoute(t, { rows: [{ id: OTHER_MEETING, recordingUrl: PARTS_KEY }] });
  for (const key of partsFiles(UPLOAD)) await put(key);
  const res = await remove(MEETING);
  assert.equal(res.status, 404);
  assert.deepEqual(m.log, [["findUnique", MEETING]]);
  assert.equal(m.rows.length, 1);
  assert.equal(await exists(PARTS_KEY), true);
});

test("T22 delete: no session is 401, a viewer is 403, the all-company view is 409; none deletes anything", async t => {
  for (const [overrides, status, code] of [
    [{ session: null }, 401],
    [{ permission: "viewer" }, 403],
    [{ tenant: { tenantId: null, crossTenant: true } }, 409, "CROSS_TENANT_READ_ONLY"],
  ]) {
    const { m, remove, put, exists } = await deleteRoute(t, { rows: [{ id: MEETING, recordingUrl: PARTS_KEY }], ...overrides });
    for (const key of [...partsFiles(UPLOAD), `${workDir(MEETING)}/normalized.mp3`]) await put(key);
    const res = await remove(MEETING);
    assert.equal(res.status, status);
    if (code) assert.equal((await res.json()).code, code);
    assert.deepEqual(m.log, [], `${status}: the meeting is not even read`);
    assert.equal(m.rows.length, 1);
    assert.equal(await exists(PARTS_KEY), true);
    assert.equal(await exists(`${workDir(MEETING)}/normalized.mp3`), true);
  }
});

test("T22 delete: a failed DB delete leaves every file in place", async t => {
  const { m, remove, put, exists } = await deleteRoute(t, {
    rows: [{ id: MEETING, recordingUrl: PARTS_KEY }], deleteError: new Error("db down"),
  });
  for (const key of [...partsFiles(UPLOAD), `${workDir(MEETING)}/normalized.mp3`]) await put(key);
  await assert.rejects(remove(MEETING), /db down/);
  assert.deepEqual(m.log, [["findUnique", MEETING], ["delete", MEETING]]);
  assert.equal(await exists(PARTS_KEY), true);
  assert.equal(await exists(`${workDir(MEETING)}/normalized.mp3`), true);
});

test("T22 delete: file cleanup failures do not fail the response, and each step is tried on its own", async t => {
  // Recording removal fails; the work folder is still removed.
  {
    const { m, remove, put, exists } = await deleteRoute(t, {
      rows: [{ id: MEETING, recordingUrl: SINGLE_KEY }], deleteFileError: new Error("blob unavailable"),
    });
    await put(SINGLE_KEY);
    await put(`${workDir(MEETING)}/normalized.mp3`);
    const res = await remove(MEETING);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(m.rows.length, 0);
    assert.equal(await exists(SINGLE_KEY), true);
    assert.equal(await exists(workDir(MEETING)), false);
  }
  // The reference count fails: the recording is kept rather than guessed.
  {
    const { m, remove, put, exists } = await deleteRoute(t, {
      rows: [{ id: MEETING, recordingUrl: PARTS_KEY }], countError: new Error("count failed"),
    });
    for (const key of partsFiles(UPLOAD)) await put(key);
    assert.equal((await remove(MEETING)).status, 200);
    assert.equal(m.rows.length, 0);
    assert.equal(await exists(PARTS_KEY), true);
  }
  // The work folder cannot be resolved (an id outside the allowed characters): still 200.
  {
    const badId = "meeting_1";
    const { m, remove, put, exists } = await deleteRoute(t, { rows: [{ id: badId, recordingUrl: PARTS_KEY }] });
    for (const key of partsFiles(UPLOAD)) await put(key);
    assert.equal((await remove(badId)).status, 200);
    assert.equal(m.rows.length, 0);
    assert.equal(await exists(`/uploads/recordings/parts/${UPLOAD}`), false);
  }
});
