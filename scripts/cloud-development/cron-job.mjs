// 無人処理の Cloud Run ジョブ（luma-platform-dev-cron / luma-platform-dev-cron-meet）が実行するスクリプトの控え。
// ジョブにはこの内容を1行にして `node --input-type=module -e` で渡している（イメージには含めない）。
// Cloud Scheduler は Google 署名の ID トークンしか付けられず、Cloud Run に直接かけた IAP を通れないため、
// ジョブのサービスアカウントが自分で署名した JWT（aud はサービス URL＋"/*"）で IAP を通り、x-cron-secret を付けて API を呼ぶ。
// 応答が 2xx でなければ異常終了する（ジョブの実行一覧で失敗が分かる）。
//
// 環境変数：TARGET_URL（サービス URL）、CRON_SA（ジョブの実行 SA のメール）、CRON_PATH（呼ぶ API。
// /api/cron/meeting-transcriptions または /api/cron/meet-artifacts）、CRON_SECRET（Secret Manager から参照）。
// 必要な権限：実行 SA 自身の iam.serviceAccountTokenCreator、対象サービスの IAP アクセス（roles/iap.httpsResourceAccessor）、
// CRON_SECRET のシークレットの読み取り。作成手順は docs/development-20260928-verification-guide.md「4. 無人処理」。
const url = process.env.TARGET_URL;
const sa = process.env.CRON_SA;
const md = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
if (!md.ok) throw new Error("metadata token " + md.status);
const { access_token } = await md.json();
const now = Math.floor(Date.now() / 1000);
const signed = await fetch("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + sa + ":signJwt", {
  method: "POST",
  headers: { Authorization: "Bearer " + access_token, "Content-Type": "application/json" },
  body: JSON.stringify({ payload: JSON.stringify({ iss: sa, sub: sa, aud: url + "/*", iat: now, exp: now + 600 }) }),
});
if (!signed.ok) throw new Error("signJwt " + signed.status);
const { signedJwt } = await signed.json();
const started = Date.now();
const r = await fetch(url + process.env.CRON_PATH, {
  headers: { Authorization: "Bearer " + signedJwt, "x-cron-secret": process.env.CRON_SECRET },
  redirect: "manual",
  signal: AbortSignal.timeout(320000),
});
const text = await r.text();
console.log(JSON.stringify({ status: r.status, elapsedMs: Date.now() - started, body: text.slice(0, 500) }));
if (!r.ok) process.exit(1);
