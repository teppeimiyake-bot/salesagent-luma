import { readFile } from "node:fs/promises";
// Cloud Run / development Neon verification. Uses isolated, disposable fixtures.
// Credentials remain in memory. Never changes the manually reviewed demo deals.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { bundleT01Sources, connectDevelopment, newFixture } from "./lib/t01-development.mjs";

// Uncaught CLI/assertion errors can include token output or session cookies.
// Keep failures fixed-text; collect diagnostics without credential-bearing values.
const failVerification = () => {
  console.error("Cloud development verification failed. Inspect scoped configuration and saved evidence; credential output was suppressed.");
  process.exit(1);
};
process.on("uncaughtException", failVerification);
process.on("unhandledRejection", failVerification);

const withVertex = process.argv.includes("--with-vertex");
const account = "yushiro.mori@luma-create.com";
const project = "lumaagentlist";
const service = "luma-platform-development";
const bucket = "lumaagentlist-luma-dev-uploads";
const region = "asia-northeast1";
function gcloud(args, options = {}) {
  return execFileSync("gcloud", [...args, `--project=${project}`, `--account=${account}`, "--quiet"],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000, ...options });
}
const config = JSON.parse(gcloud(["run", "services", "describe", service, `--region=${region}`, "--format=json"]));
assert.equal(config.metadata.name, service);
const env = Object.fromEntries(config.spec.template.spec.containers[0].env.filter(x => x.value !== undefined).map(x => [x.name, x.value]));
assert.equal(env.LUMA_DEPLOYMENT_ENV, "development");
assert.equal(env.GOOGLE_CLOUD_PROJECT, project);
assert.equal(env.LUMA_CLOUD_AI_MODE, withVertex ? "vertex" : "off");
if (withVertex) {
  assert.equal(env.AI_PROVIDER, "vertex"); assert.equal(env.AI_PROVIDER_HEAVY, "vertex");
  assert.equal(env.VERTEX_MODEL, "gemini-3.5-flash-lite"); assert.equal(env.VERTEX_LOCATION, "global");
  assert.equal(env.LUMA_VERTEX_BUDGET_JPY, "25000");
}
assert.equal(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, bucket);
const initialVertexCalls = withVertex ? JSON.parse(gcloud(["storage", "cat", `gs://${bucket}/verification/vertex-budget-20260923.json`])).attempts.length : 0;
const baseUrl = config.status.url;
assert.match(baseUrl, /^https:\/\/luma-platform-development-[a-z0-9-]+\.a\.run\.app$/);
const iapEnabled = config.metadata.annotations?.["run.googleapis.com/iap-enabled"] === "true";
let authentication;
if (iapEnabled) {
  // Dedicated verifier has access only to this development IAP resource.
  // IAM signs a short-lived token without exporting a service account key.
  const verifier = "luma-platform-dev-verifier@lumaagentlist.iam.gserviceaccount.com";
  const accessToken = gcloud(["auth", "print-access-token"]).trim();
  const issuedAt = Math.floor(Date.now() / 1000);
  const signed = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${verifier}:signJwt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "x-goog-user-project": project },
    body: JSON.stringify({ payload: JSON.stringify({ iss: verifier, sub: verifier, aud: `${baseUrl}/*`, iat: issuedAt, exp: issuedAt + 900 }) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(signed.status, 200, "IAP verifier token signing");
  const result = await signed.json();
  assert.ok(typeof result.signedJwt === "string" && result.signedJwt.length > 0);
  authentication = { Authorization: `Bearer ${result.signedJwt}` };
} else {
  authentication = { "X-Serverless-Authorization": `Bearer ${gcloud(["auth", "print-identity-token"]).trim()}` };
}
let cookie = "";
async function request(path, options = {}, withSession = true) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const headers = { ...authentication, ...options.headers };
  if (withSession && cookie) headers.Cookie = cookie;
  return fetch(baseUrl + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(withVertex ? 300000 : 60000) });
}
async function jsonRequest(path, method, data) {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  return { status: response.status, data: await response.json() };
}
function check(label) { console.log(`PASS ${label}`); }

const anonymous = await fetch(baseUrl + "/login", { redirect: "manual", signal: AbortSignal.timeout(30000) });
if (iapEnabled) {
  assert.equal(anonymous.status, 302);
  assert.equal(new URL(anonymous.headers.get("location")).hostname, "accounts.google.com");
  check("IAP requires Google login for anonymous callers");
} else {
  assert.equal(anonymous.status, 403);
  check("Cloud Run rejects unauthenticated callers");
}
const loginPage = await request("/login", {}, false);
assert.equal(loginPage.status, 200);
assert.match(await loginPage.text(), /<html/);
const denied = await request("/api/deals", {}, false);
assert.ok([401, 307].includes(denied.status));
check("application login is independently required");

const fixture = newFixture();
const userId = randomUUID();
const email = `cloud-verification-${userId}@dev.test`;
const password = randomBytes(24).toString("hex");
const connection = await connectDevelopment(await bundleT01Sources(), fixture);
const db = connection.base;
let objectKey;
let created = false;
try {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.$transaction(async tx => {
    await tx.tenant.create({ data: { id: fixture.tenant, code: fixture.tag, name: "クラウド動作確認用・架空", shortName: "クラウド検証" } });
    await tx.user.create({ data: { id: userId, email, passwordHash, name: "クラウド検証用・架空", permission: "admin" } });
    await tx.userTenant.create({ data: { userId, tenantId: fixture.tenant, permission: "admin", isDefault: true } });
    await tx.company.create({ data: { id: fixture.company, name: "架空クラウド検証株式会社", note: fixture.tag, createdByTenantId: fixture.tenant } });
    await tx.deal.create({ data: { id: fixture.deal, tenantId: fixture.tenant, companyId: fixture.company, ownerUserId: userId, title: "クラウド・日時保存確認" } });
  }, { maxWait: 30000, timeout: 60000 });
  created = true;
  const login = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }, false);
  assert.equal(login.status, 200, "cloud database login");
  const setCookie = login.headers.get("set-cookie");
  assert.ok(typeof setCookie === "string" && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie), "Session cookie must include required security flags");
  cookie = setCookie.split(";")[0];
  check("Neon login and secure session cookie");
  for (const path of ["/dashboard", "/deals", `/deals/${fixture.deal}`, "/agent"]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(html.includes("<html") && !html.includes("Application error"), path);
  }
  check("four cloud application pages render");

  const dates = { meetingStartAt: "2026-10-01T05:00:00.000Z", meetingEndAt: "2026-10-01T06:00:00.000Z" };
  const saved = await jsonRequest(`/api/deals/${fixture.deal}`, "PATCH", dates);
  assert.equal(saved.status, 200);
  const persisted = await db.deal.findUniqueOrThrow({ where: { id: fixture.deal } });
  assert.equal(persisted.meetingStartAt.toISOString(), dates.meetingStartAt);
  assert.equal(persisted.meetingEndAt.toISOString(), dates.meetingEndAt);
  const invalid = await jsonRequest(`/api/deals/${fixture.deal}`, "PATCH", { ...dates, meetingEndAt: "2026-10-01T04:00:00.000Z" });
  assert.equal(invalid.status, 400);
  const refreshed = await request(`/api/deals/${fixture.deal}`);
  assert.equal(refreshed.status, 200);
  const unchanged = await db.deal.findUniqueOrThrow({ where: { id: fixture.deal } });
  assert.equal(unchanged.meetingEndAt.toISOString(), dates.meetingEndAt);
  check("T01 cloud save, reload and invalid date rejection");
  const otherDeal = await request("/api/deals/0d010000-0000-4000-8000-000000000001");
  assert.equal(otherDeal.status, 404);
  check("isolated test tenant cannot read manual demo deal");

  // Storage infrastructure check: a genuine half-second silent WAV, no AI key.
  let audio = Buffer.alloc(44 + 16000);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(16000, 40);
  if (withVertex) audio = await readFile(new URL("../.verification/cloud-development/vertex-demo.wav", import.meta.url));
  const form = new FormData();
  form.set("dealId", fixture.deal);
  form.set("file", new Blob([audio], { type: "audio/wav" }), "cloud-verification-silence.wav");
  const uploaded = await request("/api/meetings", { method: "POST", body: form });
  assert.equal(uploaded.status, 202);
  const uploadedJson = await uploaded.json();
  let meeting = uploadedJson.meeting;
  assert.equal(meeting.dealId, fixture.deal);
  assert.match(meeting.recordingUrl, /^\/uploads\/recordings\/[a-zA-Z0-9._-]+\.wav$/);
  objectKey = meeting.recordingUrl.slice("/uploads/".length);
  const downloaded = await request(`/api/meetings/${meeting.id}/recording`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), audio);
  const stored = gcloud(["storage", "cat", `gs://${bucket}/${objectKey}`], { encoding: "buffer" });
  assert.equal(createHash("sha256").update(stored).digest("hex"), createHash("sha256").update(audio).digest("hex"));
  const range = await request(`/api/meetings/${meeting.id}/recording`, { headers: { Range: "bytes=0-15" } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), audio.subarray(0, 16));
  check("app upload, actual GCS persistence, authenticated download and Range");
  if (withVertex) {
    // T04: Cloud Run returns 202 right after storage; the continuation endpoint transcribes.
    // Stop at "transcribed" so the explicit T05 analysis below is the only analysis call.
    if (uploadedJson.transcriptionMode === "job") {
      for (let attempt = 0; attempt < 10; attempt++) {
        const continued = await request(`/api/meetings/${meeting.id}/transcription`, { method: "POST" });
        assert.equal(continued.status, 200, "T04 continuation HTTP");
        const state = (await continued.json()).meeting;
        if (!["uploaded", "transcribing"].includes(state.processingStatus)) break;
      }
      meeting = await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    }
    assert.equal(meeting.processingStatus, "transcribed", meeting.processingError ?? "T04 transcription status");
    assert.equal(meeting.meta?.transcription?.provider, "vertex");
    assert.ok(meeting.meta.transcription.usage.totalTokenCount > 0);
    assert.match(meeting.transcript, /(?:80|８０|八十)万/);
    assert.match(meeting.transcript, /人事部長/);
    check("T04 actual Vertex audio transcription and token usage");

    const analysis = await request(`/api/meetings/${meeting.id}/analyze`, { method: "POST" });
    assert.equal(analysis.status, 200, "T05 analysis HTTP");
    const persistedMeeting = await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    assert.equal(persistedMeeting.processingStatus, "completed", persistedMeeting.processingError ?? "T05 completed");
    assert.equal(persistedMeeting.meta.t05MinutesFallback, false);
    assert.match(persistedMeeting.minutes, /(?:80|８０|八十)万/);
    assert.match(persistedMeeting.minutes, /山田/);
    assert.equal(persistedMeeting.transcript, meeting.transcript);
    check("T05 Vertex minutes saved without fallback; original transcript preserved");

    const bant = await request(`/api/deals/${fixture.deal}/summarize-bant`, { method: "POST" });
    assert.equal(bant.status, 200, "T06 BANT HTTP");
    const bantResult = await bant.json();
    assert.equal(bantResult.fallback, false);
    assert.match(JSON.stringify(bantResult.bant), /(?:80|８０|八十)万/);
    assert.match(JSON.stringify(bantResult.bant), /山田/);
    check("T06 Vertex BANT aggregation without fallback");

    const prepared = await request(`/api/deals/${fixture.deal}/preparation`, { method: "POST" });
    assert.ok([200, 202].includes(prepared.status), "T08-T10 preparation HTTP");
    let brief;
    for (let attempt = 0; attempt < 20; attempt++) {
      brief = await db.preparationBrief.findFirst({ where: { dealId: fixture.deal }, orderBy: { createdAt: "desc" } });
      if (brief && ["done", "error"].includes(brief.status)) break;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    assert.equal(brief?.status, "done", brief?.error ?? "T08-T10 brief status");
    assert.equal(brief.model, "gemini-3.5-flash-lite");
    assert.ok(brief.proposalStory?.includes("商材提案"));
    assert.ok(brief.talkingPoints?.vertexGrounding);
    check("T08-T10 Vertex research and proposal saved with grounding metadata");

    const ledger = JSON.parse(gcloud(["storage", "cat", `gs://${bucket}/verification/vertex-budget-20260923.json`]));
    assert.ok(ledger.attempts.slice(initialVertexCalls).every(a => a.status === "success" && a.usage?.totalTokenCount > 0));
    assert.equal(ledger.limitJpy, 25000);
    assert.ok(ledger.attempts.reduce((n, a) => n + a.reservedJpy, 0) <= ledger.limitJpy);
    console.log(JSON.stringify({ vertexCalls: ledger.attempts.length, reservedJpy: ledger.attempts.reduce((n, a) => n + a.reservedJpy, 0), inputTokens: ledger.attempts.reduce((n, a) => n + (a.usage?.promptTokenCount ?? 0), 0), outputTokens: ledger.attempts.reduce((n, a) => n + (a.usage?.candidatesTokenCount ?? 0) + (a.usage?.thoughtsTokenCount ?? 0), 0) }));
  }
  if (process.argv.includes("--verify-restart")) {
    gcloud(["run", "services", "update", service, `--region=${region}`,
      `--update-env-vars=LUMA_DEVELOPMENT_VERIFICATION_RUN=${randomUUID()}`, "--format=value(status.latestReadyRevisionName)"], { timeout: 180000 });
    const replacement = await request(`/api/meetings/${meeting.id}/recording`);
    assert.equal(replacement.status, 200);
    assert.deepEqual(Buffer.from(await replacement.arrayBuffer()), audio);
    check("saved audio survives a replacement Cloud Run revision");
  }
  console.log(withVertex ? "Google Meet live integration was not run." : "Live AI and Google Meet tests were not run.");
} finally {
  try {
    if (objectKey) gcloud(["storage", "rm", `gs://${bucket}/${objectKey}`]);
  } finally {
    try {
      if (created) {
        await db.$transaction(async tx => {
          const tenant = await tx.tenant.findUnique({ where: { id: fixture.tenant } });
          assert.equal(tenant?.code, fixture.tag);
          await tx.aiLog.deleteMany({ where: { tenantId: fixture.tenant } });
          await tx.company.delete({ where: { id: fixture.company, note: fixture.tag } });
          await tx.user.delete({ where: { id: userId, email } });
          await tx.tenant.delete({ where: { id: fixture.tenant, code: fixture.tag } });
        }, { maxWait: 30000, timeout: 60000 });
        check("disposable cloud fixtures removed");
      }
    } finally {
      await connection.close();
    }
  }
}
