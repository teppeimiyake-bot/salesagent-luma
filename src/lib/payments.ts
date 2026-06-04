/**
 * 入金管理（機能5）の共通ロジック・ラベルマップ。
 *
 * DBは enum（英大文字）で保持し、UI表示・CSV取込はこのモジュールで日本語ラベルへ相互変換する。
 * 着金金額(税込) = 契約金額(税抜) × 1.1。
 */

// ---------- enum 値（Prisma enum メンバ名と一致させる） ----------
export const PAYMENT_TIMINGS = ["PREPAID", "ON_DELIVERY", "INSTALLMENT"] as const;
export type PaymentTiming = (typeof PAYMENT_TIMINGS)[number];

export const CONTRACT_STATUSES = ["SIGNED", "UNSIGNED"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const INVOICE_SENT_STATUSES = ["SENT", "NOT_SENT", "PARTIAL_SENT"] as const;
export type InvoiceSentStatus = (typeof INVOICE_SENT_STATUSES)[number];

export const PAYMENT_RECV_STATUSES = ["CONFIRMED", "UNCONFIRMED", "PARTIAL_CONFIRMED"] as const;
export type PaymentRecvStatus = (typeof PAYMENT_RECV_STATUSES)[number];

// ---------- 日本語ラベル ----------
export const PAYMENT_TIMING_LABEL: Record<PaymentTiming, string> = {
  PREPAID: "前払い",
  ON_DELIVERY: "納品後支払い",
  INSTALLMENT: "分割支払い",
};

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  SIGNED: "締結済み",
  UNSIGNED: "未締結",
};

export const INVOICE_SENT_LABEL: Record<InvoiceSentStatus, string> = {
  SENT: "送付済み",
  NOT_SENT: "未送付",
  PARTIAL_SENT: "前金分送付済み",
};

export const PAYMENT_RECV_LABEL: Record<PaymentRecvStatus, string> = {
  CONFIRMED: "確認済み",
  UNCONFIRMED: "未確認",
  PARTIAL_CONFIRMED: "前金分確認済み",
};

// ---------- Badge variant ヘルパー（UI色分け） ----------
export function invoiceSentVariant(s: InvoiceSentStatus): "success" | "warning" | "secondary" {
  if (s === "SENT") return "success";
  if (s === "PARTIAL_SENT") return "warning";
  return "secondary";
}

export function paymentRecvVariant(s: PaymentRecvStatus): "success" | "warning" | "secondary" {
  if (s === "CONFIRMED") return "success";
  if (s === "PARTIAL_CONFIRMED") return "warning";
  return "secondary";
}

// ---------- 日本語ラベル -> enum 逆引き（CSV取込用） ----------
export function parsePaymentTiming(label: string): PaymentTiming {
  const t = label.trim();
  if (t.includes("前払")) return "PREPAID";
  if (t.includes("分割")) return "INSTALLMENT";
  if (t.includes("納品後")) return "ON_DELIVERY";
  return "PREPAID";
}

export function parseContractStatus(label: string): ContractStatus {
  return label.trim().includes("未締結") ? "UNSIGNED" : "SIGNED";
}

export function parseInvoiceSent(label: string): InvoiceSentStatus {
  const t = label.trim();
  if (t.includes("前金分")) return "PARTIAL_SENT";
  if (t.includes("未送付")) return "NOT_SENT";
  if (t.includes("送付済")) return "SENT";
  return "NOT_SENT";
}

export function parsePaymentRecv(label: string): PaymentRecvStatus {
  const t = label.trim();
  if (t.includes("前金分")) return "PARTIAL_CONFIRMED";
  if (t.includes("未確認")) return "UNCONFIRMED";
  if (t.includes("確認済")) return "CONFIRMED";
  return "UNCONFIRMED";
}

// ---------- 税込計算 ----------
export const TAX_RATE = 0.1;

/** 税抜金額から税込（着金）金額を計算。四捨五入。null安全。 */
export function grossFromNet(net: number | null | undefined): number | null {
  if (net == null) return null;
  return Math.round(net * (1 + TAX_RATE));
}

/** 円表示（¥1,234,567）。null/0 はダッシュ。 */
export function yen(n: number | null | undefined): string {
  if (n == null) return "—";
  return "¥" + n.toLocaleString("ja-JP");
}

// ---------- 月次グリッド（定期）ヘルパー ----------
/** yyyymm(整数) <-> {year, month} */
export function ym(year: number, month: number): number {
  return year * 100 + month;
}
export function fromYm(yyyymm: number): { year: number; month: number } {
  return { year: Math.floor(yyyymm / 100), month: yyyymm % 100 };
}
export function ymLabel(yyyymm: number): string {
  const { year, month } = fromYm(yyyymm);
  return `${year}/${String(month).padStart(2, "0")}`;
}

/** start..end（含む）の yyyymm 連番リスト。引数が null の場合は空配列。 */
export function ymRange(start: number, end: number): number[] {
  const out: number[] = [];
  let { year, month } = fromYm(start);
  const e = end;
  let cur = ym(year, month);
  let guard = 0;
  while (cur <= e && guard < 600) {
    out.push(cur);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    cur = ym(year, month);
    guard += 1;
  }
  return out;
}
