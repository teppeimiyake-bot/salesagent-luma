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
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { PDF_FONT_FAMILY } from "./fonts";
import { LUMA_COMPANY } from "@/lib/company-profile";
import { toWareki, yen, groupDigits } from "./format";

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
            <Text style={styles.clientName}>
              {data.clientName}　{data.clientHonorific}
            </Text>
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
            <Text style={styles.sumLabel}>消費税（{data.taxRate}%）</Text>
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
