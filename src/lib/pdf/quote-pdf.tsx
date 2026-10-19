/**
 * 見積書PDF（機能①）テンプレート。
 *
 * 見積書サンプル_岩泉町役場.docx のレイアウトに準拠：
 *   和暦日付 / 宛名（御中・様）/ Luma差出人 / タイトル「見　積　書」/ 合計金額 /
 *   委託業務名 / 明細（品目・数量・単価・金額）/ 小計・消費税10%・合計 /
 *   「上記の通り見積りいたします。」
 *
 * docx をそのまま画像化せず、文面を @react-pdf/renderer で再構成する（serverless互換・崩れ防止）。
 */
import React from "react";
import { Document, Image, Page, View, StyleSheet } from "@react-pdf/renderer";
import { PDF_FONT_FAMILY } from "./fonts";
import { Text } from "./text"; // 日本語の折り返しで「-」を足さない Text（text.tsx）
import { LUMA_COMPANY } from "@/lib/company-profile";
import { toWareki, yen, groupDigits } from "./format";
import { calculateQuote, formatJstDate, lineAmount, normalizeHonorific, type CalculableQuoteLine } from "@/lib/quote-calculation";
import { isAcceptableLogoUrl } from "@/lib/quote-issuer";

export interface QuoteLineData {
  name: string;
  detail?: string | null;
  qty: number;
  unitPrice: number;
}

export interface QuotePdfData {
  clientName: string;
  clientHonorific: string; // 御中 / 様
  subject?: string | null;
  issueDate: Date | string;
  taxRate: number; // %
  note?: string | null;
  version?: string | null;
  lines: QuoteLineData[];
}

const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: 10,
    color: "#1a1a1a",
    paddingTop: 48,
    paddingBottom: 48,
    paddingHorizontal: 44,
    lineHeight: 1.5,
  },
  dateRow: { textAlign: "right", fontSize: 10, marginBottom: 18 },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "center",
    letterSpacing: 6,
    marginBottom: 20,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  clientBlock: { width: "55%" },
  clientName: { fontSize: 15, fontWeight: "bold", marginBottom: 2, borderBottom: "1pt solid #1a1a1a", paddingBottom: 4 },
  senderBlock: { width: "42%", alignItems: "flex-end" },
  senderName: { fontSize: 12, fontWeight: "bold" },
  senderLine: { fontSize: 9, color: "#333" },
  totalBox: {
    borderWidth: 1.5,
    borderColor: "#1a1a1a",
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginBottom: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  totalLabel: { fontSize: 12, fontWeight: "bold", width: 90 },
  totalValue: { fontSize: 18, fontWeight: "bold", flex: 1, textAlign: "right" },
  totalNote: { fontSize: 8, color: "#666", marginLeft: 8 },
  subject: { fontSize: 10, marginBottom: 10 },
  subjectLabel: { fontWeight: "bold" },
  table: { borderWidth: 0.75, borderColor: "#888", marginBottom: 4 },
  tHead: { flexDirection: "row", backgroundColor: "#f1f5f9" },
  tRow: { flexDirection: "row", borderTopWidth: 0.5, borderTopColor: "#ccc" },
  th: { fontSize: 9, fontWeight: "bold", paddingVertical: 5, paddingHorizontal: 6 },
  td: { fontSize: 9, paddingVertical: 5, paddingHorizontal: 6 },
  colName: { width: "48%" },
  colQty: { width: "12%", textAlign: "right" },
  colUnit: { width: "20%", textAlign: "right" },
  colAmt: { width: "20%", textAlign: "right" },
  detailText: { fontSize: 7.5, color: "#666", marginTop: 1 },
  sumTable: { marginTop: 8, alignSelf: "flex-end", width: "45%" },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: "#ddd" },
  sumLabel: { fontSize: 10 },
  sumValue: { fontSize: 10, textAlign: "right" },
  sumTotalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderTopWidth: 1, borderTopColor: "#1a1a1a", marginTop: 2 },
  sumTotalLabel: { fontSize: 11, fontWeight: "bold" },
  sumTotalValue: { fontSize: 12, fontWeight: "bold" },
  closing: { marginTop: 28, fontSize: 11 },
  noteBlock: { marginTop: 18, fontSize: 9, color: "#444" },
  noteLabel: { fontWeight: "bold", marginBottom: 2 },
});

export function QuotePdf({ data }: { data: QuotePdfData }) {
  const subtotal = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const tax = Math.floor((subtotal * data.taxRate) / 100);
  const total = subtotal + tax;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.dateRow}>{toWareki(data.issueDate)}</Text>

        <Text style={styles.title}>見　積　書</Text>

        <View style={styles.headerRow}>
          <View style={styles.clientBlock}>
            <Text style={styles.clientName}>{`${data.clientName}　${data.clientHonorific}`}</Text>
            {data.version ? <Text style={{ fontSize: 8, color: "#888", marginTop: 3 }}>{data.version}</Text> : null}
          </View>
          <View style={styles.senderBlock}>
            <Text style={styles.senderName}>{LUMA_COMPANY.name}</Text>
            <Text style={styles.senderLine}>{LUMA_COMPANY.representative}</Text>
            <Text style={styles.senderLine}>{LUMA_COMPANY.address}</Text>
          </View>
        </View>

        <View style={styles.totalBox}>
          <Text style={styles.totalLabel}>御見積金額</Text>
          <Text style={styles.totalValue}>{yen(total)}</Text>
          <Text style={styles.totalNote}>（税込）</Text>
        </View>

        {data.subject ? (
          <Text style={styles.subject}>
            <Text style={styles.subjectLabel}>委託業務名：</Text>
            {data.subject}
          </Text>
        ) : null}

        {/* 明細テーブル */}
        <View style={styles.table}>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.colName]}>品目</Text>
            <Text style={[styles.th, styles.colQty]}>数量</Text>
            <Text style={[styles.th, styles.colUnit]}>単価</Text>
            <Text style={[styles.th, styles.colAmt]}>金額</Text>
          </View>
          {data.lines.map((l, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <View style={[styles.td, styles.colName]}>
                <Text>{l.name}</Text>
                {l.detail ? <Text style={styles.detailText}>{l.detail}</Text> : null}
              </View>
              <Text style={[styles.td, styles.colQty]}>{groupDigits(l.qty)}</Text>
              <Text style={[styles.td, styles.colUnit]}>{yen(l.unitPrice)}</Text>
              <Text style={[styles.td, styles.colAmt]}>{yen(l.qty * l.unitPrice)}</Text>
            </View>
          ))}
        </View>

        {/* 小計・消費税・合計 */}
        <View style={styles.sumTable}>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>小計</Text>
            <Text style={styles.sumValue}>{yen(subtotal)}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>{`消費税（${data.taxRate}%）`}</Text>
            <Text style={styles.sumValue}>{yen(tax)}</Text>
          </View>
          <View style={styles.sumTotalRow}>
            <Text style={styles.sumTotalLabel}>合計</Text>
            <Text style={styles.sumTotalValue}>{yen(total)}</Text>
          </View>
        </View>

        <Text style={styles.closing}>上記の通り見積りいたします。</Text>

        {data.note ? (
          <View style={styles.noteBlock}>
            <Text style={styles.noteLabel}>備考</Text>
            <Text>{data.note}</Text>
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export interface QuoteIssuerPdfData {
  legalName: string;
  postalCode: string;
  addressLine1: string;
  addressLine2: string;
  logoUrl?: string | null;
}

export interface QuotePdfV2Data {
  quoteNumber: string;
  clientName: string;
  clientHonorific: string;
  subject?: string | null;
  issueDate: Date | string;
  note?: string | null;
  issuer: QuoteIssuerPdfData;
  lines: CalculableQuoteLine[];
}

const v2 = StyleSheet.create({
  page: { fontFamily: PDF_FONT_FAMILY, fontSize: 9, color: "#111", paddingTop: 34, paddingBottom: 42, paddingHorizontal: 38 },
  title: { fontSize: 22, fontWeight: "bold", textAlign: "center", letterSpacing: 5, marginBottom: 18 },
  header: { flexDirection: "row", justifyContent: "space-between", minHeight: 92, marginBottom: 12 },
  recipient: { width: "54%", paddingTop: 10 },
  recipientName: { fontSize: 14, fontWeight: "bold", borderBottomWidth: 1, paddingBottom: 4 },
  issuer: { width: "42%", alignItems: "flex-end" },
  logo: { maxWidth: 100, maxHeight: 24, objectFit: "contain", marginBottom: 3 },
  issuerName: { fontSize: 11, fontWeight: "bold" },
  meta: { marginTop: 7, alignItems: "flex-end" },
  total: { fontSize: 15, fontWeight: "bold", borderBottomWidth: 1.2, paddingVertical: 6, marginBottom: 12 },
  subject: { marginBottom: 8 },
  // T14: 罫線は外枠の View に持たせない。外枠はページをまたいで分割されるため、1ページ目では左罫線だけが
  // 下余白まで伸び、2ページ目では繰り返しの見出し行に上罫線が付かなかった。
  // 左罫線は各行（見出し行・明細行）、上罫線は見出し行、下罫線は各行に持たせ、行ごとに閉じた枠にする。
  table: {},
  row: { flexDirection: "row", borderLeftWidth: 1, borderLeftColor: "#777", borderBottomWidth: 1, borderBottomColor: "#aaa", minHeight: 26 },
  head: { backgroundColor: "#f1f1f1", fontWeight: "bold", minHeight: 24, borderTopWidth: 1, borderTopColor: "#777" },
  cell: { paddingHorizontal: 5, paddingVertical: 5, borderRightWidth: 1, borderColor: "#aaa" },
  name: { width: "42%" },
  price: { width: "18%", textAlign: "right" },
  qty: { width: "10%", textAlign: "right" },
  unit: { width: "10%", textAlign: "center" },
  amount: { width: "20%", textAlign: "right" },
  detail: { fontSize: 7.2, color: "#555", marginTop: 2 },
  summaries: { width: "48%", alignSelf: "flex-end", marginTop: 8 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 0.5, borderColor: "#bbb", paddingVertical: 3 },
  grand: { fontSize: 11, fontWeight: "bold", borderTopWidth: 1, marginTop: 2, paddingTop: 4 },
  notes: { marginTop: 16, borderWidth: 1, borderColor: "#aaa", padding: 8, minHeight: 54 },
  noteTitle: { fontWeight: "bold", marginBottom: 3 },
  footer: { position: "absolute", bottom: 18, left: 38, width: 519, height: 14, textAlign: "center", fontSize: 8, color: "#666" },
});

/**
 * PDF に描くロゴ。取得済みの PNG/JPEG の data URL だけを描く（https の URL は発行・プレビューの前に
 * src/lib/quote-logo-pdf.ts が短い上限時間で取得して data URL にする）。react-pdf に URL やファイルを
 * 取りに行かせない：取得の失敗を黙って省き、時間の上限も無く、サーバー内部へも接続できてしまうため。
 */
export function renderableQuoteLogo(value: string | null | undefined): string | null {
  return value && value.startsWith("data:") && isAcceptableLogoUrl(value) ? value : null;
}

/**
 * T14 V2。印影は仕様上常に描画しない。
 *
 * 1つの <Text> の中身は1つの文字列にまとめる（`{a}：{b}` のように分けない）。react-pdf は文字列の
 * 境目を「ハイフンを足す改行位置」として扱うため、分けると境目で「-」付きの折り返しが起きうる。
 */
export function QuotePdfV2({ data }: { data: QuotePdfV2Data }) {
  const totals = calculateQuote(data.lines);
  const recipient = normalizeHonorific(data.clientName, data.clientHonorific);
  const renderableLogo = renderableQuoteLogo(data.issuer.logoUrl);
  return (
    <Document>
      <Page size="A4" style={v2.page} wrap>
        <Text style={v2.title}>見　積　書</Text>
        <View style={v2.header}>
          <View style={v2.recipient}>
            <Text style={v2.recipientName}>{`${recipient.clientName}　${recipient.honorific}`}</Text>
            {data.subject ? <Text style={{ marginTop: 10 }}>{`件名：${data.subject}`}</Text> : null}
          </View>
          <View style={v2.issuer}>
            {/* react-pdf ImageはHTMLのalt属性を持たない。ロゴは発行者名を直後に文字でも表示する。 */}
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            {renderableLogo ? <Image src={renderableLogo} style={v2.logo} /> : null}
            <Text style={v2.issuerName}>{data.issuer.legalName}</Text>
            <Text>{`〒${data.issuer.postalCode}`}</Text>
            <Text>{data.issuer.addressLine1}</Text>
            <Text>{data.issuer.addressLine2}</Text>
            <View style={v2.meta}>
              <Text>{`見積番号：${data.quoteNumber}`}</Text>
              <Text>{`発行日：${formatJstDate(data.issueDate)}`}</Text>
            </View>
          </View>
        </View>
        <Text style={v2.total}>{`御見積金額　${yen(totals.grandTotal)}（税込）`}</Text>
        <View style={v2.table}>
          <View style={[v2.row, v2.head]} fixed>
            <Text style={[v2.cell, v2.name]}>品目</Text><Text style={[v2.cell, v2.price]}>単価</Text>
            <Text style={[v2.cell, v2.qty]}>数量</Text><Text style={[v2.cell, v2.unit]}>単位</Text><Text style={[v2.cell, v2.amount]}>価格</Text>
          </View>
          {data.lines.map((line, index) => (
            <View style={v2.row} key={`${index}-${line.name}`} wrap={false}>
              <View style={[v2.cell, v2.name]}><Text>{line.name}</Text>{line.detail ? <Text style={v2.detail}>{line.detail}</Text> : null}</View>
              <Text style={[v2.cell, v2.price]}>{yen(line.unitPrice)}</Text><Text style={[v2.cell, v2.qty]}>{groupDigits(line.qty)}</Text>
              <Text style={[v2.cell, v2.unit]}>{line.unit}</Text><Text style={[v2.cell, v2.amount]}>{yen(lineAmount(line))}</Text>
            </View>
          ))}
        </View>
        <View style={v2.summaries} wrap={false}>
          <View style={v2.summaryRow}><Text>小計</Text><Text>{yen(totals.subtotal)}</Text></View>
          {totals.groups.filter((g) => g.taxCategory === "taxable").map((group) => (
            <View style={v2.summaryRow} key={`tax-${group.taxRate}`}><Text>{`${group.taxRate}%対象 / 消費税`}</Text><Text>{`${yen(group.base)} / ${yen(group.tax)}`}</Text></View>
          ))}
          {totals.nonTaxableBase > 0 ? <View style={v2.summaryRow}><Text>不課税対象</Text><Text>{yen(totals.nonTaxableBase)}</Text></View> : null}
          <View style={[v2.summaryRow, v2.grand]}><Text>合計</Text><Text>{yen(totals.grandTotal)}</Text></View>
        </View>
        {data.note ? <View style={v2.notes} wrap={false}><Text style={v2.noteTitle}>備考</Text><Text>{data.note}</Text></View> : null}
        <Text style={v2.footer} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>
    </Document>
  );
}
