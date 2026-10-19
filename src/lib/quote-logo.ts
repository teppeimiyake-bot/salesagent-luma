import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { MAX_LOGO_URL_LENGTH } from "./quote-issuer";

/**
 * T14: 見積書の発行者ロゴ（https のURL）をサーバーから取りに行く。管理画面の保存時と、発行・プレビューの前に使う。
 *
 * 以前は URL のまま react-pdf に渡していたため、到達できない URL でも保存も発行も黙って通り、
 * PDF にロゴが無いことに気づけなかった（404 の URL では react-pdf の取得待ちで発行に11秒かかった）。
 * ここで短い時間で取得して PNG/JPEG を確かめ、data URL にしてから PDF へ渡す。
 *
 * 利用者が入れた URL をサーバーが取りに行くので、SSRF にならないよう次を守る。
 * - https だけ。ポートは既定（443）だけ。URL に利用者名・パスワードがあるものは断る。
 * - localhost・プライベート・リンクローカル（169.254.169.254 のメタデータサーバー）などの内部アドレスは断る。
 *   IP を直接書いた URL は接続前に、ホスト名は接続時の名前解決（lookup）の結果で確かめる
 *   （確かめた名前解決の結果でそのまま接続するので、確認と接続の間に向き先を変えられない）。
 * - リダイレクトは自動では追わず、行き先を同じ条件で確かめてから最大3回まで追う（http への格下げは断る）。
 * - 全体（リダイレクト込み）に時間の上限を付け、本文は上限サイズを超えたら読むのをやめる。
 */

/** 管理画面で保存するときの取得の上限時間。 */
export const LOGO_SAVE_TIMEOUT_MS = 5_000;
/** 見積の発行・プレビューのときの取得の上限時間（これを過ぎたらロゴなしで出す）。 */
export const LOGO_ISSUE_TIMEOUT_MS = 4_000;
/** 取得する画像の上限（バイト）。data URL にしたときに MAX_LOGO_URL_LENGTH（画面で選ぶ画像と同じ約290KB）に収まる大きさ。 */
export const MAX_LOGO_BYTES = Math.floor((MAX_LOGO_URL_LENGTH - "data:image/jpeg;base64,".length) / 4) * 3;
const MAX_REDIRECTS = 3;

const BLOCKED_CODE = "ELOGO_BLOCKED_ADDRESS";
const REASON = {
  notHttps: "https のURLだけ使えます",
  credentials: "URL に利用者名やパスワードは入れられません",
  port: "https の標準ポート（443）以外の URL は使えません",
  internal: "社内・内部向けのアドレスには接続しません",
  notFound: "サーバーが見つかりません（名前解決できません）",
  connect: "サーバーに接続できませんでした",
  tls: "https の証明書を確認できませんでした",
  notImage: "PNG か JPEG の画像ではありません",
  tooLarge: "画像が大きすぎます（約290KBまで）",
  tooManyRedirects: "リダイレクトが多すぎます",
  badRedirect: "リダイレクト先が正しくありません",
} as const;

// IPv4 と IPv6 で表を分ける（1つの BlockList では IPv4 のアドレスが ::/96 などの IPv6 の規則にも当たる）
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  // ::/96（未指定・IPv4互換）、::ffff:0:0/96（IPv4射影。中の IPv4 が内部でも外部でも断る）、NAT64、
  // 6to4・Teredo（IPv4 を埋め込む）、ULA、リンクローカル、サイトローカル、マルチキャスト、文書用（2001:db8::/32・3fff::/20）、SRv6 SID（5f00::/16）
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["3fff::", 20], ["5f00::", 16], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(network, prefix, "ipv6");

/** 接続してはいけない（公開インターネットではない）アドレスか。IP として読めないものも断る。 */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family === 6) return blockedV6.check(address, "ipv6");
  return true;
}

/** 接続する前に URL だけで分かる理由（https・ポート・内部向けの名前・IP 直書き）を確かめる。問題なければ null。 */
function targetProblem(url: URL): string | null {
  if (url.protocol !== "https:") return REASON.notHttps;
  if (url.username || url.password) return REASON.credentials;
  if (url.port && url.port !== "443") return REASON.port;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return REASON.internal;
  if (net.isIP(host) && isBlockedAddress(host)) return REASON.internal;
  return null;
}

export type ResolvedAddress = { address: string; family: number };
export type LogoResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type LogoResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy?: () => void;
};
export type LogoRequest = (url: URL, init: { signal: AbortSignal; lookup: net.LookupFunction }) => Promise<LogoResponse>;

const systemResolver: LogoResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** 名前解決の結果に内部アドレスが1つでも含まれていれば接続させない lookup（https.request の lookup に渡す）。 */
function guardedLookup(resolve: LogoResolver): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((found) => {
      const addresses = options.family === 4 || options.family === 6 ? found.filter((a) => a.family === options.family) : found;
      if (!addresses.length) throw Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" });
      if (found.some((a) => isBlockedAddress(a.address))) {
        throw Object.assign(new Error(`blocked address for ${hostname}`), { code: BLOCKED_CODE });
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch((error: NodeJS.ErrnoException) => callback(error, "", 0));
  };
}

/** 既定の取得処理。リダイレクトは追わず（呼び出し側で確かめて追う）、接続ごとに guardedLookup で名前解決する。 */
const httpsRequest: LogoRequest = (url, { signal, lookup }) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: "GET", agent: false, lookup, signal,
    headers: { Accept: "image/png,image/jpeg", "User-Agent": "LumaQuoteLogo/1.0 (+quote issuer logo check)" },
  }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => res.destroy() }));
  req.on("error", reject);
  req.end();
});

export type QuoteLogoFetchResult =
  | { ok: true; dataUrl: string; contentType: "image/png" | "image/jpeg"; bytes: number }
  | { ok: false; reason: string };

function imageType(head: Buffer): "image/png" | "image/jpeg" | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  return null;
}

function reasonFor(error: unknown, timeoutMs: number): string {
  const e = error as NodeJS.ErrnoException | undefined;
  const code = e?.code ?? "";
  if (e?.name === "AbortError" || code === "ABORT_ERR") return `時間内に取得できませんでした（${Math.round(timeoutMs / 1000)}秒）`;
  if (code === BLOCKED_CODE) return REASON.internal;
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA", "ENODATA"].includes(code)) return REASON.notFound;
  if (/^(?:CERT_|ERR_TLS|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/.test(code)) return REASON.tls;
  return REASON.connect;
}

class LogoProblem extends Error {}

/**
 * https のロゴ URL を取得し、PNG/JPEG なら data URL にして返す。取れなければ理由（日本語）を返す（例外は投げない）。
 * `request` / `resolve` はテスト用の差し替え口（既定は node:https と OS の名前解決）。
 */
export async function fetchQuoteLogo(
  rawUrl: string,
  options: { timeoutMs: number; maxBytes?: number; request?: LogoRequest; resolve?: LogoResolver },
): Promise<QuoteLogoFetchResult> {
  const { timeoutMs, maxBytes = MAX_LOGO_BYTES, request = httpsRequest, resolve = systemResolver } = options;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: REASON.notHttps }; }
  const early = targetProblem(url);
  if (early) return { ok: false, reason: early };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 取得処理が signal を無視しても上限時間で必ず戻る
  const deadline = new Promise<QuoteLogoFetchResult>((done) => {
    timer = setTimeout(() => {
      controller.abort();
      done({ ok: false, reason: `時間内に取得できませんでした（${Math.round(timeoutMs / 1000)}秒）` });
    }, timeoutMs);
  });
  const lookup = guardedLookup(resolve);

  const attempt = (async (): Promise<QuoteLogoFetchResult> => {
    let current = url;
    for (let hop = 0; ; hop++) {
      const response = await request(current, { signal: controller.signal, lookup });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.destroy?.();
        if (hop >= MAX_REDIRECTS) throw new LogoProblem(REASON.tooManyRedirects);
        const location = [response.headers.location].flat()[0];
        let next: URL;
        try { next = new URL(String(location ?? ""), current); } catch { throw new LogoProblem(REASON.badRedirect); }
        if (!location) throw new LogoProblem(REASON.badRedirect);
        const problem = targetProblem(next);
        if (problem) throw new LogoProblem(problem);
        current = next;
        continue;
      }
      if (response.status !== 200) {
        response.destroy?.();
        throw new LogoProblem(response.status === 404 ? "画像が見つかりません（HTTP 404）" : `画像を取得できませんでした（HTTP ${response.status}）`);
      }
      const declared = Number([response.headers["content-length"]].flat()[0]);
      if (Number.isFinite(declared) && declared > maxBytes) { response.destroy?.(); throw new LogoProblem(REASON.tooLarge); }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) { response.destroy?.(); throw new LogoProblem(REASON.tooLarge); }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const contentType = imageType(body);
      if (!contentType) throw new LogoProblem(REASON.notImage);
      return { ok: true, dataUrl: `data:${contentType};base64,${body.toString("base64")}`, contentType, bytes: body.length };
    }
  })().catch((error: unknown): QuoteLogoFetchResult => ({
    ok: false, reason: error instanceof LogoProblem ? error.message : reasonFor(error, timeoutMs),
  }));

  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
