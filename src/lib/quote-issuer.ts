import type { Prisma, QuoteIssuerProfile } from "@prisma/client";

/**
 * 標準備考の初期値（1行＝1項目。新規見積では既定で入れる）。
 * サンプル見積書 00_Docs/999_サンプル/見積書/*.pdf 9件すべてにある2行を pdftotext で抜き出した原文（2026-09-30）。
 */
export const DEFAULT_QUOTE_NOTES = [
  "※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。",
  "※消費税はご契約日時点での税率となります。",
].join("\n");
/**
 * 交通費備考の選択肢の初期値（1行＝選択肢1つ。見積ごとに選ぶ・既定なし）。
 * サンプル4件が1行目、1件が2行目の文面（2行目は原文どおり句点なし）。残り4件は交通費備考なし。
 */
export const DEFAULT_TRAVEL_NOTE = [
  "※撮影交通費は撮影地をご相談の上、別途実費分をご負担いただきます。",
  "※撮影交通費は別途ご相談の上貴社にご負担いただきます",
].join("\n");

/** 発行者設定がまだ無いテナントの初期値（初回発行時に作る行・設定画面の初期表示で共通）。 */
export function defaultIssuerProfileData(tenant: { name: string; code: string }) {
  return {
    legalName: tenant.name,
    postalCode: "170-0013",
    addressLine1: "東京都豊島区東池袋",
    addressLine2: "2-7-3 柄澤ビル3F",
    logoUrl: null as string | null,
    defaultNotes: DEFAULT_QUOTE_NOTES,
    travelExpenseNote: DEFAULT_TRAVEL_NOTE as string | null,
    numberPrefix: tenant.code === "luma" ? "L" : tenant.code.slice(0, 1).toUpperCase(),
    nextQuoteNumber: 1,
  };
}

/** ロゴとして保存できる data URL の上限（文字数。PNG/JPEG で 約290KB）。発行ごとに issuerSnapshot へ複写されるため小さく保つ。 */
export const MAX_LOGO_URL_LENGTH = 400_000;

/**
 * 見積書PDFのロゴとして受け付ける値か。react-pdf が埋め込めるのは PNG/JPEG なので、
 * https のURLか、PNG/JPEG の base64 data URL だけを許す。
 */
export function isAcceptableLogoUrl(value: string): boolean {
  if (value.length > MAX_LOGO_URL_LENGTH) return false;
  if (value.startsWith("data:")) return /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export interface QuoteIssuerSnapshot {
  legalName: string;
  postalCode: string;
  addressLine1: string;
  addressLine2: string;
  logoUrl: string | null;
  numberPrefix: string;
}

export async function ensureQuoteIssuerProfile(
  db: unknown,
  tenantId: string,
): Promise<QuoteIssuerProfile> {
  // Prismaのtenant extension clientとtransaction clientは型シグネチャが異なるが、
  // ここで使うdelegateは両方に存在するため共通のTransactionClient面へ絞る。
  const client = db as Prisma.TransactionClient;
  const existing = await client.quoteIssuerProfile.findFirst({ where: { tenantId } });
  if (existing) return existing;
  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { name: true, code: true } });
  if (!tenant) throw new Error("発行者のテナント情報が見つかりません");
  return client.quoteIssuerProfile.create({ data: { tenantId, ...defaultIssuerProfileData(tenant) } });
}

export function issuerSnapshot(
  profile: Pick<QuoteIssuerProfile, "legalName" | "postalCode" | "addressLine1" | "addressLine2" | "logoUrl" | "numberPrefix">,
): QuoteIssuerSnapshot {
  return {
    legalName: profile.legalName,
    postalCode: profile.postalCode,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    logoUrl: profile.logoUrl,
    numberPrefix: profile.numberPrefix,
  };
}

export function parseIssuerSnapshot(value: Prisma.JsonValue | null | undefined): QuoteIssuerSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (![v.legalName, v.postalCode, v.addressLine1, v.addressLine2].every((x) => typeof x === "string")) return null;
  return {
    legalName: v.legalName as string,
    postalCode: v.postalCode as string,
    addressLine1: v.addressLine1 as string,
    addressLine2: v.addressLine2 as string,
    logoUrl: typeof v.logoUrl === "string" ? v.logoUrl : null,
    numberPrefix: typeof v.numberPrefix === "string" ? v.numberPrefix : "L",
  };
}

export function quoteNumber(prefix: string, issueDate: Date | string, sequence: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(issueDate));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${prefix}-${value("year")}${value("month")}${value("day")}-${String(sequence).padStart(4, "0")}`;
}
