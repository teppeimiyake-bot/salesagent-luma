/**
 * 入金管理（機能5）のUI共通：各 enum 値の色分けバッジ tone と、フィルタ定義。
 * spot-table.tsx / recurring-grid.tsx 双方から再利用する。
 *
 * 方針：
 *  - 表示はバッジ（色で一目で分かる）、編集時は従来どおり <Select>。
 *  - tone は yomi-filter.tsx の {active, idle} 二態と同形式で、フィルタトグルにも流用する。
 */
import {
  PAYMENT_TIMINGS,
  CONTRACT_STATUSES,
  INVOICE_SENT_STATUSES,
  PAYMENT_RECV_STATUSES,
  PAYMENT_TIMING_LABEL,
  CONTRACT_STATUS_LABEL,
  INVOICE_SENT_LABEL,
  PAYMENT_RECV_LABEL,
  type PaymentTiming,
  type ContractStatus,
  type InvoiceSentStatus,
  type PaymentRecvStatus,
} from "@/lib/payments";

/** バッジ単色（border/bg/text のTailwindクラスをまとめたClassName） */
export type BadgeTone = string;
/** フィルタトグル（active=選択中 / idle=非選択） */
export type FilterTone = { active: string; idle: string };

// ---------- バッジ表示用 tone ----------
// 支払時期：前払い=緑（健全） / 納品後=琥珀（後払いリスク） / 分割=スカイ
export const PAYMENT_TIMING_BADGE: Record<PaymentTiming, BadgeTone> = {
  PREPAID: "bg-emerald-100 text-emerald-700 border-emerald-200",
  ON_DELIVERY: "bg-amber-100 text-amber-700 border-amber-200",
  INSTALLMENT: "bg-sky-100 text-sky-700 border-sky-200",
};

// 契約締結：締結済み=緑 / 未締結=グレー
export const CONTRACT_STATUS_BADGE: Record<ContractStatus, BadgeTone> = {
  SIGNED: "bg-emerald-100 text-emerald-700 border-emerald-200",
  UNSIGNED: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

// 請求書送付：送付済み=緑 / 未送付=赤 / 前金分送付済み=黄
export const INVOICE_SENT_BADGE: Record<InvoiceSentStatus, BadgeTone> = {
  SENT: "bg-emerald-100 text-emerald-700 border-emerald-200",
  NOT_SENT: "bg-red-100 text-red-700 border-red-200",
  PARTIAL_SENT: "bg-amber-100 text-amber-700 border-amber-200",
};

// 着金状況：確認済み=緑 / 未確認=赤 / 前金分確認済み=黄
export const PAYMENT_RECV_BADGE: Record<PaymentRecvStatus, BadgeTone> = {
  CONFIRMED: "bg-emerald-100 text-emerald-700 border-emerald-200",
  UNCONFIRMED: "bg-red-100 text-red-700 border-red-200",
  PARTIAL_CONFIRMED: "bg-amber-100 text-amber-700 border-amber-200",
};

// ---------- フィルタトグル用 tone（active/idle） ----------
const TONE = {
  emerald: {
    active: "bg-emerald-600 text-white border-emerald-600",
    idle: "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50",
  },
  amber: {
    active: "bg-amber-600 text-white border-amber-600",
    idle: "bg-white text-amber-700 border-amber-200 hover:bg-amber-50",
  },
  red: {
    active: "bg-red-600 text-white border-red-600",
    idle: "bg-white text-red-700 border-red-200 hover:bg-red-50",
  },
  sky: {
    active: "bg-sky-600 text-white border-sky-600",
    idle: "bg-white text-sky-700 border-sky-200 hover:bg-sky-50",
  },
  zinc: {
    active: "bg-zinc-700 text-white border-zinc-700",
    idle: "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
  },
} satisfies Record<string, FilterTone>;

export const PAYMENT_TIMING_FILTER_TONE: Record<PaymentTiming, FilterTone> = {
  PREPAID: TONE.emerald,
  ON_DELIVERY: TONE.amber,
  INSTALLMENT: TONE.sky,
};
export const CONTRACT_STATUS_FILTER_TONE: Record<ContractStatus, FilterTone> = {
  SIGNED: TONE.emerald,
  UNSIGNED: TONE.zinc,
};
export const INVOICE_SENT_FILTER_TONE: Record<InvoiceSentStatus, FilterTone> = {
  SENT: TONE.emerald,
  NOT_SENT: TONE.red,
  PARTIAL_SENT: TONE.amber,
};
export const PAYMENT_RECV_FILTER_TONE: Record<PaymentRecvStatus, FilterTone> = {
  CONFIRMED: TONE.emerald,
  UNCONFIRMED: TONE.red,
  PARTIAL_CONFIRMED: TONE.amber,
};

// ---------- スポットのフィルタ定義（再利用しやすいように1配列に集約） ----------
export type SpotFilterKey =
  | "paymentTiming"
  | "contractStatus"
  | "invoiceStatus"
  | "paymentStatus";

export type SpotFilterDef<V extends string = string> = {
  key: SpotFilterKey;
  label: string;
  values: readonly V[];
  labelMap: Record<V, string>;
  tone: Record<V, FilterTone>;
  /** デフォルト選択（未指定＝全選択扱い） */
  defaultSelected?: readonly V[];
};

export const SPOT_FILTERS: SpotFilterDef[] = [
  {
    key: "paymentTiming",
    label: "支払時期",
    values: PAYMENT_TIMINGS,
    labelMap: PAYMENT_TIMING_LABEL,
    tone: PAYMENT_TIMING_FILTER_TONE,
  },
  {
    key: "contractStatus",
    label: "契約締結",
    values: CONTRACT_STATUSES,
    labelMap: CONTRACT_STATUS_LABEL,
    tone: CONTRACT_STATUS_FILTER_TONE,
  },
  {
    key: "invoiceStatus",
    label: "請求書送付",
    values: INVOICE_SENT_STATUSES,
    labelMap: INVOICE_SENT_LABEL,
    tone: INVOICE_SENT_FILTER_TONE,
  },
  {
    key: "paymentStatus",
    label: "着金状況",
    values: PAYMENT_RECV_STATUSES,
    labelMap: PAYMENT_RECV_LABEL,
    tone: PAYMENT_RECV_FILTER_TONE,
    // 着金状況のデフォルト＝未確認 + 前金分確認済み（確認済みを初期で隠し、未着金/一部着金にフォーカス）
    defaultSelected: ["UNCONFIRMED", "PARTIAL_CONFIRMED"],
  },
];
