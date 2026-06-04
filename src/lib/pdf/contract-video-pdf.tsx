/**
 * 映像 業務委託契約書PDF（機能②）。
 *
 * 条項全文は docs/templates/契約書_映像_テキスト.txt を正として移植。
 * 差込項目（QUOTE_CONTRACT_SPEC 準拠）：
 *   - 甲（委託者）= Company.name
 *   - 乙（受託者）= 会社設定定数（株式会社Luma）
 *   - 納入品 = 既定「PR映像」（上書き可）
 *   - 本業務完了日 = 納品予定日 or expectedCloseDate（手修正可）
 *   - 契約金額 = DealProduct.amount（税抜）
 */
import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { PDF_FONT_FAMILY } from "./fonts";
import { LUMA_COMPANY } from "@/lib/company-profile";
import { kingaku } from "./format";

export interface VideoContractData {
  clientName: string; // 甲
  deliverable: string; // 納入品（既定 PR映像）
  completionDate: string; // 本業務完了日（"202●年●月●日" 形式、空可）
  contractAmount: number; // 税抜
  signDate: string; // 契約締結日（"202●年●月●日" 形式、空可）
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
  headBox: { borderWidth: 0.75, borderColor: "#888", padding: 8, marginBottom: 12 },
  headRow: { flexDirection: "row", marginBottom: 2 },
  headLabel: { width: 90, fontWeight: "bold", fontSize: 9 },
  headValue: { flex: 1, fontSize: 9 },
  intro: { marginBottom: 10, fontSize: 9 },
  artTitle: { fontWeight: "bold", fontSize: 9.5, marginTop: 8, marginBottom: 1 },
  art: { fontSize: 9, marginBottom: 1 },
  bullet: { fontSize: 9, marginLeft: 12, marginBottom: 1 },
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

export function VideoContractPdf({ data }: { data: VideoContractData }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>業務委託契約書</Text>

        <View style={styles.headBox}>
          <View style={styles.headRow}>
            <Text style={styles.headLabel}>納入品</Text>
            <Text style={styles.headValue}>{data.deliverable || "PR映像"}</Text>
          </View>
          <View style={styles.headRow}>
            <Text style={styles.headLabel}>本業務完了日</Text>
            <Text style={styles.headValue}>{data.completionDate || "202●年●月●日"}</Text>
          </View>
          <View style={styles.headRow}>
            <Text style={styles.headLabel}>納入方法</Text>
            <Text style={styles.headValue}>ギガファイル便</Text>
          </View>
          <View style={styles.headRow}>
            <Text style={styles.headLabel}>契約金額</Text>
            <Text style={styles.headValue}>{kingaku(data.contractAmount)}（消費税別）</Text>
          </View>
        </View>

        <Text style={styles.intro}>
          委託者　{data.clientName || "株式会社●●"}（以下「甲」という）と受託者　{LUMA_COMPANY.name}
          （以下「乙」という）とは、次の条項により業務委託契約（以下「本契約」という）を締結する。
        </Text>

        <Article title="（目的）第1条">
          <Text style={styles.art}>
            甲は、映像制作を目的として、以下に定める業務（以下「本業務」という）を乙に委託し、乙はこれを受託するものとする。なお、本業務の詳細及び具体的遂行方法等については甲乙別途協議のうえ書面にて定めるものとする。
          </Text>
          <Text style={styles.bullet}>・撮影業務</Text>
          <Text style={styles.bullet}>・編集業務</Text>
          <Text style={styles.bullet}>・その他映像制作に付随する業務</Text>
        </Article>

        <Article title="（許認可等の取得）第2条">
          <Text style={styles.art}>
            乙は、本業務の遂行のために、関係する国、地方公共団体等の許認可等の取得、届出等必要なすべての手続きを自らの費用と責任において取らなければならない。
          </Text>
          <Text style={styles.art}>
            甲が要求した場合、乙は前項の手続きが完了したことを証明する文書を甲に速やかに提出しなければならない。
          </Text>
        </Article>

        <Article title="（検査）第3条">
          <Text style={styles.art}>
            乙は、頭書に定める本業務完了日までに第2項以下に定める甲の検査に合格し、本業務を完了しなければならない。乙は、本業務を遂行し、本業務を終了したときは、本業務終了の通知を甲に対して行う。
          </Text>
          <Text style={styles.art}>
            甲は、前項に規定する本業務終了通知を受理した日から起算して10日以内に甲が別に定める基準に従い検査を行い、乙が実施した本業務が合格であると認めた場合は、本業務が完了した旨を乙に通知する。なお、本通知をもって、当該本業務が完了するとともに頭書に定める納入品の納入が完了したものとする。
          </Text>
          <Text style={styles.art}>
            乙は、前項に定める検査の結果が不合格となった場合で甲の指示があったときは、修正等を行い再度甲の検査を受けるものとする。
          </Text>
          <Text style={styles.art}>甲は乙に対して3回まで修正を求めることができる。</Text>
          <Text style={styles.art}>
            甲が4回以上、修正を求める場合、1回の修正につき金1万円（消費税別）を支払うものとする。
          </Text>
        </Article>

        <Article title="（所有権の移転及び危険負担）第4条">
          <Text style={styles.art}>
            納入品の所有権は、前条に定める本業務の完了をもって、乙から甲に移転する。
          </Text>
          <Text style={styles.art}>
            前項の規定による所有権の移転前に生じた納入品の毀損又は滅失等による損害は、全て乙の負担とする。但し、当該損害が専ら甲の故意又は過失により生じた場合は、この限りではない。
          </Text>
        </Article>

        <Article title="（知的財産権）第5条">
          <Text style={styles.art}>
            納入品及び本業務実施の過程で創作された著作物に係る著作権（著作権法第27条及び第28条に規定する権利を含む）は、本業務の完了とともに乙から甲に移転するものとする。なお、当該著作権の移転の対価も契約金額に含まれるものとする。ただし、乙から制作物の使用の要請があった場合、甲の許可する範囲で乙は著作物の使用をすることができる。
          </Text>
          <Text style={styles.art}>
            乙は、甲（甲より利用許諾又は権利譲渡を受けた第三者を含む）に対し、納入品及び本業務実施の過程で創作された著作物に係る著作者人格権を行使しないものとする。
          </Text>
        </Article>

        <Article title="（支払）第6条">
          <Text style={styles.art}>
            甲は、本業務の一切の対価として、頭書に定める契約金額を乙に対して支払うものとする。
          </Text>
          <Text style={styles.art}>
            甲は、契約金額を契約日の翌月末日までに、その金額に課税される消費税相当額とともに乙の指定する金融機関の口座に振込むことによって支払うものとする。
          </Text>
        </Article>

        <Article title="（契約不適合）第7条">
          <Text style={styles.art}>
            甲は、納入品又は本業務の成果について、種類、品質、数量等本契約に定める内容に適合しない状態（以下「契約不適合」という）が判明した場合、当該契約不適合を知った時から1ヶ月以内に限り、本業務の再履行、当該契約不適合の修補又は代替品の納入を乙に対し請求することができる。
          </Text>
          <Text style={styles.art}>
            前項の規定は、甲が当該不適合の存在を知り、又は重大な過失により知らなかった場合は適用しない。
          </Text>
        </Article>

        <Article title="（履行遅滞）第8条">
          <Text style={styles.art}>
            乙は、頭書に定める本業務完了日までに本業務を完了することができないと見込まれるときは、直ちに、その理由、完了予定日等を甲に届け出てその指示を受けるものとする。
          </Text>
          <Text style={styles.art}>
            1．前項の定めに従い乙が届出をなしたことをもって乙の責任が免ぜられるものではなく、前項に定める甲の指示の有無にかかわらず乙の遅滞が容認されるものではない。
          </Text>
        </Article>

        <Article title="（権利義務の移転）第9条">
          <Text style={styles.art}>
            乙は、本契約に基づき、甲に対して有する権利又は甲に対して負う義務の全部又は一部を第三者に譲渡し、承継させ、又は担保に供してはならない。
          </Text>
        </Article>

        <Article title="（甲の都合による解約）第10条">
          <Text style={styles.art}>
            甲は､本業務が完了しない間、自己の都合によりいつでも本契約の全部又は一部を解約することができる。この場合甲は、解約時までの乙の本業務の出来高及び進捗率等の履行実績並びに本業務の遂行に伴い乙が負担した合理的な費用に応じた相当の金額を支払うものとする。
          </Text>
        </Article>

        <Article title="（守秘義務）第11条">
          <Text style={styles.art}>
            乙は、甲の事前の書面による承諾なくして、本契約の存在及び内容、本業務の成果、乙が本契約を通じて知得したアイディア、ノウハウ、データ等の甲の技術上、営業上及び業務上の一切の情報（以下総称して「秘密情報」という）を本業務遂行の目的以外に使用せず、第三者に開示、漏洩しないものとする。
          </Text>
          <Text style={styles.art}>
            前項の規定にかかわらず、乙が次の各号の一に該当することを立証し得た情報は、秘密情報には含まれないものとする。
          </Text>
          <Text style={styles.bullet}>・自己の責に帰すことのできない事由により、提供の時点で既に公知であるか又は提供後に公知となった場合</Text>
          <Text style={styles.bullet}>・提供の時点で既に保有していた場合</Text>
          <Text style={styles.bullet}>・第三者から守秘義務を負うことなく適法に入手した場合</Text>
          <Text style={styles.bullet}>・独自に開発した場合</Text>
          <Text style={styles.art}>
            乙は､自己の役職員又は第三者に秘密情報等を使用させた場合、当該役職員又は第三者に本契約と同様の守秘義務を課すとともに、当該役職員（退職又は退任後も含む）又は第三者が守秘義務に違反することのないように、必要な措置を講じなければならない。
          </Text>
          <Text style={styles.art}>
            本条の規定については、本契約の終了にかかわらず、その効力は消滅せず、なお有効に存続するものとする。
          </Text>
        </Article>

        <Article title="（反社会的勢力の排除）第12条">
          <Text style={styles.art}>
            甲及び乙は、次の各号のいずれか一にも該当しないことを表明し、かつ将来にわたっても該当しないことを表明し、保証する。
          </Text>
          <Text style={styles.bullet}>・自ら又は自らの役員が、暴力団、暴力団員、暴力団員でなくなった時から5年を経過しない者、暴力団準構成員、暴力団関係企業、総会屋、社会運動等標ぼうゴロ又は特殊知能暴力集団等その他これらに準じる者（以下総称して「暴力団員等」という）であること</Text>
          <Text style={styles.bullet}>・暴力団員等が経営を支配していると認められる関係を有すること</Text>
          <Text style={styles.bullet}>・暴力団員等が経営に実質的に関与していると認められる関係を有すること</Text>
          <Text style={styles.bullet}>・自ら若しくは第三者の不正の利益を図る目的又は第三者に損害を加える目的をもってするなど、暴力団員等を利用していると認められる関係を有すること</Text>
          <Text style={styles.bullet}>・暴力団員等に対して資金等を提供し、又は便宜を供与するなどの関与をしていると認められる関係を有すること</Text>
          <Text style={styles.bullet}>・自らの役員又は自らの経営に実質的に関与している者が暴力団員等と社会的に非難されるべき関係を有すること</Text>
          <Text style={styles.art}>
            甲及び乙は、自ら又は第三者を利用して次の各号のいずれか一にでも該当する行為を行わないことを保証する。
          </Text>
          <Text style={styles.bullet}>・暴力的な要求行為</Text>
          <Text style={styles.bullet}>・法的な責任を超えた不当な要求行為</Text>
          <Text style={styles.bullet}>・取引に関して、脅迫的な言動をし、又は暴力を用いる行為</Text>
          <Text style={styles.bullet}>・風説を流布し、偽計を用い又は威力を用いて相手方の信用を毀損し、又は相手方の業務を妨害する行為</Text>
        </Article>

        <Article title="（紛争の解決）第13条">
          <Text style={styles.art}>
            甲及び乙は、本契約に関する一切の紛争については、甲の本店所在地を管轄する裁判所をもって第一審の専属的合意管轄裁判所とすることに合意する。
          </Text>
        </Article>

        <Article title="（協議解決）第14条">
          <Text style={styles.art}>
            本契約の解釈並びにその他の事項につき生じた疑義や本契約に規定のない事項については、甲乙双方が誠意をもって協議のうえ、解決をするものとする。
          </Text>
        </Article>

        <Article title="（準拠法）第15条">
          <Text style={styles.art}>
            本契約の成立、効力、解釈及び履行については、日本国法に準拠するものとする。本契約締結の証として、本書2通を作成し、甲乙記名押印のうえ、各1通を保有する。
          </Text>
        </Article>

        <View style={styles.signBlock}>
          <Text style={styles.signDate}>{data.signDate || "202●年●月●日"}</Text>
          <View style={styles.signCols}>
            <View style={styles.signCol}>
              <Text style={styles.signParty}>甲</Text>
              <Text style={styles.signLine}>{data.clientName || "●●株式会社"}</Text>
              <Text style={styles.signLine}>代表取締役社長　　●●</Text>
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
