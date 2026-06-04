/**
 * SNS運用 業務委託契約書PDF（機能②）。
 *
 * 条項全文は docs/templates/契約書_SNS運用_テキスト.txt を正として移植。
 * 差込項目（QUOTE_CONTRACT_SPEC 準拠）：
 *   - 甲 = Company.name
 *   - 第3条 実施期間 = serviceStart/End（手修正可）
 *   - 第4条 委託料 = 契約総額（税抜）＝初期費用＋月額×月数
 *   - 初期費用 = 既定 100,000円（税抜）
 *   - 運用費用 = 月額・割賦／契約月数
 */
import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { PDF_FONT_FAMILY } from "./fonts";
import { LUMA_COMPANY } from "@/lib/company-profile";
import { groupDigits } from "./format";

export interface SnsContractData {
  clientName: string; // 甲
  periodStart: string; // 実施開始（"202●年●月●日"、空可）
  periodEnd: string; // 実施終了（"202●年●月●日"、空可）
  totalFee: number; // 委託料総額（税抜）
  initialFee: number; // 初期費用（税抜・既定10万）
  monthlyFee: number; // 月額割賦（税抜）
  months: number; // 割賦月数（既定6）
  signDate: string; // 締結日（"202●年●月●日"、空可）
}

const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: 9,
    color: "#1a1a1a",
    paddingTop: 44,
    paddingBottom: 48,
    paddingHorizontal: 48,
    lineHeight: 1.55,
  },
  title: { fontSize: 18, fontWeight: "bold", textAlign: "center", letterSpacing: 4, marginBottom: 16 },
  intro: { marginBottom: 10, fontSize: 9 },
  artTitle: { fontWeight: "bold", fontSize: 9.5, marginTop: 8, marginBottom: 1 },
  art: { fontSize: 9, marginBottom: 1 },
  bullet: { fontSize: 9, marginLeft: 12, marginBottom: 1 },
  highlight: { fontSize: 9, marginBottom: 1, backgroundColor: "#fff8e1" },
  signBlock: { marginTop: 22 },
  signDate: { fontSize: 9, marginBottom: 10 },
  signCols: { flexDirection: "row", justifyContent: "space-between" },
  signCol: { width: "48%" },
  signParty: { fontSize: 9, fontWeight: "bold", marginBottom: 4 },
  signLine: { fontSize: 9, marginBottom: 2 },
  sealNote: { fontSize: 8, color: "#888", marginTop: 4 },
});

function Article({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View wrap={false}>
      <Text style={styles.artTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function SnsContractPdf({ data }: { data: SnsContractData }) {
  const period =
    data.periodStart || data.periodEnd
      ? `${data.periodStart || "202●年●月●日"}　～　${data.periodEnd || "202●年●月●日"}`
      : "202●年●月●日　～　202●年●月●日";

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>業務委託契約書</Text>

        <Text style={styles.intro}>
          {data.clientName || "株式会社●●"}（以下「甲」という。）と{LUMA_COMPANY.name}
          （以下「乙」という。）は、SNSアカウント運用業務の委託（以下「本件業務」という。）に関し、次のとおり本契約を締結する。
        </Text>

        <Article title="第１条（業務委託）">
          <Text style={styles.art}>甲は本件業務を乙に委託し、乙はこれを受託する。</Text>
        </Article>

        <Article title="第２条（本件業務の内容）">
          <Text style={styles.art}>
            本件業務とは、次の各号に掲げる業務とする。本条の全項に関し乙は甲の指示に基づき業務を遂行する。
          </Text>
          <Text style={styles.bullet}>(1) SNSアカウント運用業務（TikTok・Instagram・YouTube）</Text>
          <Text style={styles.bullet}>(2) 広告運用業務</Text>
          <Text style={styles.bullet}>(3) クリエイティブ制作業務</Text>
          <Text style={styles.bullet}>(4) 前各号に付随又は類似する業務</Text>
        </Article>

        <Article title="第３条（本件業務の実施時期）">
          <Text style={styles.art}>乙は、次の期間内において本件業務を受託する。</Text>
          <Text style={styles.highlight}>{period}</Text>
        </Article>

        <Article title="第４条（委託料等）">
          <Text style={styles.highlight}>
            本件業務の履行に対する対価は、金{groupDigits(data.totalFee)}円（税抜）とし、そのうち乙は初期費用である金
            {groupDigits(data.initialFee)}円（税抜）を第3条に定める実施期間初月の翌月末日までに、運用費用を毎月末日に
            {data.months}ヶ月の割賦金額である金{groupDigits(data.monthlyFee)}
            円（税抜）を甲に請求し、甲は請求月の翌月末日までに乙が指定する口座に振り込むものとする。
          </Text>
          <Text style={styles.art}>
            1．本件業務の遂行に必要な広告宣伝費、交通費、宿泊費等は乙と相談の上、甲が負担するものとする。
          </Text>
        </Article>

        <Article title="第５条（本件業務の実施）">
          <Text style={styles.art}>１．乙は本契約に従い本件業務を履行する。</Text>
          <Text style={styles.art}>２．乙は、定期的に本件業務の進捗状況を甲に報告する。</Text>
          <Text style={styles.art}>
            ３．乙は、本件業務の履行に遅延が生じるおそれがあると判断したときには、ただちに甲にその旨を通知し、甲の指示をうける。
          </Text>
          <Text style={styles.art}>
            ４．前項の規定は、当該遅延が甲の責に帰すべき事由による場合を除き、乙の債務不履行に基づく責任を免除するものではない。
          </Text>
        </Article>

        <Article title="第６条（資料の提供）">
          <Text style={styles.art}>
            甲は、乙から要求がある場合にはその都度、本件業務の履行に必要であると甲が考える資料及びデータを自らの責任と費用負担において乙に提供する。
          </Text>
        </Article>

        <Article title="第７条（再委託）">
          <Text style={styles.art}>
            １．乙は、乙の責任において本件業務の全部又は一部を、第三者（以下、「本件委託先」という。）に委託することができる。
          </Text>
          <Text style={styles.art}>
            ２．乙は、本件委託先との間で、本件業務を遂行させることについて、本契約に基づいて乙が負担するのと同様の義務を本件委託先に負わせるものとする。
          </Text>
          <Text style={styles.art}>
            ３．乙は、本件委託先による本件業務の全部又は一部の提供について、甲の責めに帰すべき事由がある場合を除き、自ら遂行した場合と同様の責任を負うものとする。
          </Text>
        </Article>

        <Article title="第８条（作業場所）">
          <Text style={styles.art}>
            乙が本件業務を履行する作業場所は、特に甲が指定する場合を除き、乙の定める場所とする。
          </Text>
        </Article>

        <Article title="第９条（従業員）">
          <Text style={styles.art}>
            本件業務に従事する乙の従業員の労務管理及び作業管理は乙の責任において行う。
          </Text>
        </Article>

        <Article title="第１０条（貸与品・支給品）">
          <Text style={styles.art}>
            １．甲が必要と認める場合、甲は、乙に対して本件業務の履行に必要な施設、設備、備品、技術資料等（以下「貸与品」という。）を貸与し、又は本件業務の履行に必要な物品等（以下「支給品」という。）を支給することができる。
          </Text>
          <Text style={styles.art}>
            ２．前項の貸与品又は支給品は、原則として無償で貸与又は支給される。ただし、甲が、特に必要と認めた場合には有償とし、その対価は甲所定の規定価格とする。
          </Text>
          <Text style={styles.art}>
            ３．前項による無償支給品の所有権は甲に存ずるものとし、有償支給品の所有権は、その代金決裁のあったとき、甲から乙に移転する。
          </Text>
          <Text style={styles.art}>
            ４．乙は、貸与品及び支給品を善良な管理者の注意をもって保管し、乙の責に帰す事由による滅失、毀損又は変質については、乙は、その損害を賠償しなければならない。
          </Text>
          <Text style={styles.art}>５．乙は、貸与品又は支給品を貸与又は支給された目的以外に使用してはならない。</Text>
          <Text style={styles.art}>
            ６．本契約が終了しもしくは解除された場合又は甲が返還を請求した場合には、乙は当該貸与品及び無償支給品をただちに甲に返還する。甲が、有償支給品についての買戻の請求をしたときには、乙は、甲からの支給価格で当該有償支給品を遅滞なく甲に売却する。
          </Text>
        </Article>

        <Article title="第１１条（著作権）">
          <Text style={styles.art}>
            １．本件業務に関して作成される著作物の著作権（著作権法第２１条から第２８条に定めるすべての権利を含む）は、甲に帰属する。
          </Text>
        </Article>

        <Article title="第１２条（権利譲渡等の禁止）">
          <Text style={styles.art}>
            甲及び乙は、あらかじめ相手方の書面による承諾を得ないかぎり、第三者に本契約によって生じる権利を譲渡し、義務を引受けさせてはならない。
          </Text>
        </Article>

        <Article title="第１３条（秘密保持）">
          <Text style={styles.art}>
            １．秘密情報とは、各当事者が保有する技術情報、営業情報、顧客情報、個人情報、目的物及びこれに関する情報、社内の業務に関する情報、その他の当事者が個別に指定した情報で、相手方に対して開示する情報をいう。紙、磁気テープ、ディスク等の電子記録媒体に記録されているか、あるいは口頭その他の方法で表現されているかを問わない。
          </Text>
          <Text style={styles.art}>
            ２．前項の個人情報とは、「個人情報の保護に関する法律」（平成１５年法律第５７号）第２条に定義するもののうち個人に関する情報をいう。
          </Text>
          <Text style={styles.art}>３．次の各号の一に該当する場合には、秘密情報として取り扱わない。</Text>
          <Text style={styles.bullet}>(1) 既に公知のもの又は乙の責に帰することのできない事由により公知となったもの</Text>
          <Text style={styles.bullet}>(2) 既に保有しているもの</Text>
          <Text style={styles.bullet}>(3) 守秘義務を負うことなく第三者から正当に入手したもの</Text>
          <Text style={styles.bullet}>(4) 秘密情報によらずに独自に開発し又は知り得たもの</Text>
          <Text style={styles.bullet}>(5) 秘密情報の対象から除外する旨を甲が書面により承諾したもの</Text>
          <Text style={styles.art}>
            ４．本件業務に関し、各当事者は、善良なる管理者の注意義務をもって秘密を保持し、相手方の書面による事前の承諾を得なければ第三者に開示してはならない。但し、法令、規則、通達又はその他政府機関若しくは裁判所の命令・処分に基づく検査、調査又は尋問を受け、秘密情報の開示の義務が課された場合はこの限りではない。
          </Text>
          <Text style={styles.art}>
            ５．各当事者は、相手方より開示された秘密情報を、本件業務上必要な場合を除いて複製・加工してはならず、適切に保管しなければならない。
          </Text>
          <Text style={styles.art}>
            ６．各当事者は、秘密情報を本件業務の遂行を目的としてのみ使用することができ、この使用目的以外には使用できないものとする。
          </Text>
        </Article>

        <Article title="第１４条（契約解除）">
          <Text style={styles.art}>
            １．本契約の有効期間は、第３条記載の期間とする。但し、甲又は乙が契約期間満了の1ケ月前までにその相手方に対し継続の申し入れをしなかったときは、本契約は終了するものとする。
          </Text>
          <Text style={styles.bullet}>(1) 手形又は小切手が不渡りとなったとき。</Text>
          <Text style={styles.bullet}>(2) 保有する財産について差押え、もしくは競売の申し立てがあったとき、又は租税滞納処分を受けたとき。</Text>
          <Text style={styles.bullet}>(3) 破産手続開始、民事再生手続開始、会社更生手続開始、特別清算開始の申立て若しくは特定調停手続開始、その他これらに類似する倒産手続開始の申し立てがあったとき、又は清算に入ったとき。</Text>
          <Text style={styles.bullet}>(4) 解散又は事業の全部もしくは重要な一部を第三者に譲渡しようとしたとき。</Text>
          <Text style={styles.bullet}>(5) 監督省庁から営業の取消・停止処分等を受けたとき。</Text>
          <Text style={styles.bullet}>(6) 現在若しくは過去において反社会的勢力（暴力団、総会屋その他の反社会的な団体又は個人をいいます。）であり若しくはあった場合又は現在若しくは過去において反社会的勢力と資本関係、業務関係、取引関係、交友関係その他の関係があり若しくはあった場合</Text>
          <Text style={styles.bullet}>(7) 法令違反、犯罪若しくはそれらのおそれのある行為をした場合又は刑事事件に関与している疑いがあることにより本契約を継続することによって相手方の信用が害されるおそれがある場合</Text>
          <Text style={styles.bullet}>(8) 相手方又は相手方の顧客若しくは取引先の利益、業務、信用、名声又は社会的地位を不当に害する行為をした場合</Text>
          <Text style={styles.art}>
            ２．甲又は乙は、前項各号のいずれか一つに該当したときは、当然に期限の利益を失い、相手方に対して負担する一切の金銭債務を直ちに弁済する。
          </Text>
        </Article>

        <Article title="第１５条（有効期間）">
          <Text style={styles.art}>１．本契約の有効期間は、第３条記載の期間とする。</Text>
          <Text style={styles.art}>２．第１３条は、本契約の終了後、又は解除後も効力を失わないものとする。</Text>
        </Article>

        <Article title="第１６条（損害賠償）">
          <Text style={styles.art}>
            １．甲又は乙は、本契約に基づく債務を履行しないことにより相手方に損害を与えた場合、これに起因する一切の損害を賠償する責任を負う。
          </Text>
          <Text style={styles.art}>
            ２．甲又は乙が、第１４条により契約解除を行った場合には、相手方に対し、これに起因する一切の損害の賠償を請求することができる。
          </Text>
          <Text style={styles.art}>
            ３．乙が本契約の終了後、又は解除後に第１１条または第１３条に違反した場合には、甲は乙に対し、これに起因する一切の損害の賠償を請求することができる。
          </Text>
        </Article>

        <Article title="第１７条（協議）">
          <Text style={styles.art}>
            本契約に定めのない事項及び本契約中疑義の生じた事項については甲乙別途協議のうえ決定する。
          </Text>
        </Article>

        <Article title="第１８条（専属的合意管轄裁判所）">
          <Text style={styles.art}>
            本契約に関し裁判上の紛争が生じたときの第一審の専属的合意管轄裁判所は民事訴訟法の定めによる。
          </Text>
          <Text style={styles.art}>
            本契約締結を証するため、本書２通を作成し、甲乙が記名押印のうえ、各１通を保有する。
          </Text>
        </Article>

        <View style={styles.signBlock}>
          <Text style={styles.signDate}>{data.signDate || "202●年●月●日"}</Text>
          <View style={styles.signCols}>
            <View style={styles.signCol}>
              <Text style={styles.signParty}>甲</Text>
              <Text style={styles.signLine}>【会社名】{data.clientName || "株式会社●●"}</Text>
              <Text style={styles.signLine}>【役職】代表者名</Text>
              <Text style={styles.sealNote}>印</Text>
            </View>
            <View style={styles.signCol}>
              <Text style={styles.signParty}>乙</Text>
              <Text style={styles.signLine}>{LUMA_COMPANY.contractAddress}</Text>
              <Text style={styles.signLine}>{LUMA_COMPANY.name}</Text>
              <Text style={styles.signLine}>{LUMA_COMPANY.representative}</Text>
              <Text style={styles.sealNote}>印</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}
