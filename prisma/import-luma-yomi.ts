/**
 * Lumaヨミ表 (Notion) → salesagent_luma DB 投入スクリプト
 *
 * 使い方:
 *   ドライラン:  npx tsx prisma/import-luma-yomi.ts
 *   本投入:      npx tsx prisma/import-luma-yomi.ts --apply
 *
 * 設計:
 * - 1Notionページ → companies 1 + deals 1 + contacts 複数 + deal_products 最大4
 * - 既存 deals.bant.notionPageId をユニークキーにupsert
 * - 既存 admin / pipeline_stages 14 / lead_sources 6 は触らない（追加のみ）
 * - 全 deal.ownerUserId = teppei@luma-create.com（admin）固定
 */

import { prisma } from "../src/lib/db";

// ----- 設定 -----
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DB_ID = "d8c936ff-4923-4000-83b1-9a588f0b1546";
const NOTION_VERSION = "2025-09-03";
const ADMIN_EMAIL = "teppei@luma-create.com";

// Notionの「リード」selectで使われる10種を lead_sources に追加（既存6件は維持）
const NEW_LEAD_SOURCES = [
  "映像",
  "SNS運用",
  "CATV",
  "IS",
  "インバウンド",
  "MV",
  "インスタDM",
  "ＸＤＭ",
  "アライアンス",
  "既存企業",
];

// ステータス正規化（全角2 → 半角2）
function normalizeStatus(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.replace("２", "2");
}

// ピックアップ系
function pickTitle(prop: any): string | null {
  if (!prop || prop.type !== "title") return null;
  const arr = prop.title || [];
  return arr.map((t: any) => t.plain_text).join("").trim() || null;
}
function pickRichText(prop: any): string | null {
  if (!prop || prop.type !== "rich_text") return null;
  const arr = prop.rich_text || [];
  const s = arr.map((t: any) => t.plain_text).join("").trim();
  return s || null;
}
function pickSelect(prop: any): string | null {
  if (!prop || prop.type !== "select" || !prop.select) return null;
  return prop.select.name || null;
}
function pickStatus(prop: any): string | null {
  if (!prop || prop.type !== "status" || !prop.status) return null;
  return prop.status.name || null;
}
function pickMultiSelect(prop: any): string[] {
  if (!prop || prop.type !== "multi_select") return [];
  return (prop.multi_select || []).map((m: any) => m.name);
}
function pickDate(prop: any): string | null {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return prop.date.start || null;
}
function pickNumber(prop: any): number | null {
  if (!prop || prop.type !== "number") return null;
  return typeof prop.number === "number" ? prop.number : null;
}
function pickUrl(prop: any): string | null {
  if (!prop || prop.type !== "url") return null;
  return prop.url || null;
}
function pickCheckbox(prop: any): boolean {
  if (!prop || prop.type !== "checkbox") return false;
  return !!prop.checkbox;
}
function pickPeopleIds(prop: any): string[] {
  if (!prop || prop.type !== "people") return [];
  return (prop.people || []).map((p: any) => p.id);
}
function pickLastEditedTime(prop: any): string | null {
  if (!prop || prop.type !== "last_edited_time") return null;
  return prop.last_edited_time || null;
}

// 「先方担当者名」をカンマ・読点・改行・スラッシュで分割
function splitContactNames(s: string | null): string[] {
  if (!s) return [];
  return s
    .split(/[、,，\n\r\/／\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// メールlocal-partをカンマ・スペースなどで複数取り扱う
function splitEmails(s: string | null): string[] {
  if (!s) return [];
  return s
    .split(/[、,，\s\n\r\/／;；]+/)
    .map((x) => x.trim())
    .filter((x) => /@/.test(x));
}

// 簡易ローマ字辞書（よく使われる苗字・名）
// マッチしたらメールlocal-partと部分一致するか判定する
const ROMAJI_MAP: Record<string, string[]> = {
  // 苗字
  "佐藤": ["sato", "satoh", "satou"],
  "鈴木": ["suzuki"],
  "高橋": ["takahashi"],
  "田中": ["tanaka"],
  "渡辺": ["watanabe"],
  "伊藤": ["ito", "itoh", "itou"],
  "山本": ["yamamoto"],
  "中村": ["nakamura"],
  "小林": ["kobayashi"],
  "加藤": ["kato", "katoh", "katou"],
  "吉田": ["yoshida"],
  "山田": ["yamada"],
  "佐々木": ["sasaki"],
  "山口": ["yamaguchi"],
  "斎藤": ["saito", "saitoh", "saitou"],
  "斉藤": ["saito", "saitoh", "saitou"],
  "松本": ["matsumoto"],
  "井上": ["inoue"],
  "木村": ["kimura"],
  "林": ["hayashi"],
  "清水": ["shimizu"],
  "山崎": ["yamazaki", "yamasaki"],
  "中島": ["nakajima", "nakashima"],
  "池田": ["ikeda"],
  "阿部": ["abe"],
  "橋本": ["hashimoto"],
  "山下": ["yamashita"],
  "森": ["mori"],
  "石川": ["ishikawa"],
  "前田": ["maeda"],
  "藤田": ["fujita"],
  "後藤": ["goto", "gotoh", "gotou"],
  "岡田": ["okada"],
  "長谷川": ["hasegawa"],
  "村上": ["murakami"],
  "近藤": ["kondo", "kondoh", "kondou"],
  "石井": ["ishii"],
  "斎": ["sai", "saito"],
  "三宅": ["miyake"],
  "脇坂": ["wakisaka"],
  "三浦": ["miura"],
  "西村": ["nishimura"],
  "藤井": ["fujii"],
  "岡本": ["okamoto"],
  "松田": ["matsuda"],
  "原": ["hara"],
  "中川": ["nakagawa"],
  "中野": ["nakano"],
  "原田": ["harada"],
  "小川": ["ogawa"],
  "竹内": ["takeuchi"],
  "金子": ["kaneko"],
  "和田": ["wada"],
  "中山": ["nakayama"],
  "石田": ["ishida"],
  "上田": ["ueda"],
  "森田": ["morita"],
  "柴田": ["shibata"],
  "酒井": ["sakai"],
  "工藤": ["kudo", "kudoh", "kudou"],
  "横山": ["yokoyama"],
  "宮崎": ["miyazaki"],
  "宮本": ["miyamoto"],
  "内田": ["uchida"],
  "高木": ["takagi"],
  "安藤": ["ando", "andoh", "andou"],
  "島田": ["shimada"],
  "谷口": ["taniguchi"],
  "大野": ["ono", "ohno"],
  "高田": ["takada"],
  "丸山": ["maruyama"],
  "今井": ["imai"],
  "増田": ["masuda"],
  "藤原": ["fujiwara"],
  "杉山": ["sugiyama"],
  "野口": ["noguchi"],
  "千葉": ["chiba"],
  "菅原": ["sugawara"],
  "村田": ["murata"],
  "久保": ["kubo"],
  "松井": ["matsui"],
  "土屋": ["tsuchiya"],
  "渡部": ["watanabe", "watabe"],
  "大塚": ["otsuka", "ohtsuka"],
  "小島": ["kojima"],
  "小山": ["koyama"],
  "新井": ["arai"],
  "野村": ["nomura"],
  "田村": ["tamura"],
  "武田": ["takeda"],
  "上野": ["ueno"],
  "杉本": ["sugimoto"],
  "千田": ["chida", "senda"],
  // 名（一部）
  "太郎": ["taro", "tarou"],
  "次郎": ["jiro", "jirou"],
  "三郎": ["saburo", "saburou"],
  "一郎": ["ichiro", "ichirou"],
  "雄大": ["yudai", "yuudai", "yuhdai"],
  "哲平": ["teppei", "tepei"],
  "翔": ["sho", "shou"],
  "翔太": ["shota", "shouta"],
  "健": ["ken"],
  "健太": ["kenta"],
  "大輔": ["daisuke"],
  "大樹": ["daiki"],
  "拓也": ["takuya"],
  "亮": ["ryo", "ryou"],
  "亮太": ["ryota", "ryouta"],
  "誠": ["makoto"],
  "勇": ["isamu", "yu"],
  "学": ["manabu", "gaku"],
  "敦": ["atsushi"],
  "渉": ["wataru"],
  "光": ["hikaru", "ko"],
  "陽介": ["yosuke", "yousuke"],
  "雄介": ["yusuke", "yuusuke"],
  "祐介": ["yusuke", "yuusuke"],
  "圭": ["kei"],
  "圭太": ["keita"],
  "智": ["satoshi", "tomo"],
  "聡": ["satoshi"],
  "直人": ["naoto"],
  "和也": ["kazuya"],
  "雅之": ["masayuki"],
  "美咲": ["misaki"],
  "美穂": ["miho"],
  "結衣": ["yui"],
  "彩": ["aya"],
  "葵": ["aoi"],
  "由美": ["yumi"],
  "恵": ["megumi", "kei"],
  "愛": ["ai"],
  "麻衣": ["mai"],
  "茜": ["akane"],
  "桜": ["sakura"],
  "舞": ["mai"],
  "陽子": ["yoko", "youko"],
  "智子": ["tomoko", "satoko"],
  "由香": ["yuka"],
  "百合子": ["yuriko"],
};

function nameToRomajiCandidates(name: string): string[] {
  // 苗字 / 名を空白で分けて、各部分の候補を列挙
  const parts = name.split(/[\s　]+/).filter(Boolean);
  const cands: string[] = [];
  for (const p of parts) {
    if (ROMAJI_MAP[p]) {
      for (const r of ROMAJI_MAP[p]) cands.push(r.toLowerCase());
    }
    // 1文字単位でも辞書ヒットがあれば
    for (const ch of p) {
      if (ROMAJI_MAP[ch]) {
        for (const r of ROMAJI_MAP[ch]) cands.push(r.toLowerCase());
      }
    }
  }
  return Array.from(new Set(cands));
}

function tryMatchEmailToName(email: string, names: string[]): string | null {
  const local = email.split("@")[0]?.toLowerCase() || "";
  if (!local) return null;
  for (const n of names) {
    const cands = nameToRomajiCandidates(n);
    for (const c of cands) {
      if (local.includes(c)) return n;
    }
  }
  return null;
}

// ----- Notion fetch -----
async function fetchAllNotionPages(): Promise<any[]> {
  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY not set");
  const out: any[] = [];
  let cursor: string | undefined = undefined;
  let page = 0;
  while (true) {
    page++;
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(
      `https://api.notion.com/v1/data_sources/${NOTION_DB_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    if (!r.ok) throw new Error(`Notion query failed: ${r.status} ${await r.text()}`);
    const j: any = await r.json();
    out.push(...(j.results || []));
    console.log(`  page ${page}: pulled ${j.results?.length || 0} (total ${out.length}, has_more=${j.has_more})`);
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return out;
}

// ----- main -----
async function main() {
  // Safety check #1: DB
  const dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl.includes("salesagent_luma")) {
    console.error("ABORT: DATABASE_URL does not contain 'salesagent_luma'. Refusing to run.");
    process.exit(1);
  }
  // Safety check #2: NOTION_API_KEY
  if (!NOTION_API_KEY) {
    console.error("ABORT: NOTION_API_KEY not set");
    process.exit(1);
  }
  // Safety check #3: admin user exists
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!admin) {
    console.error(`ABORT: admin user '${ADMIN_EMAIL}' not found`);
    process.exit(1);
  }
  if (admin.permission !== "admin") {
    console.error(`ABORT: user '${ADMIN_EMAIL}' permission=${admin.permission}, expected 'admin'`);
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  console.log(apply ? "[APPLY MODE]" : "[DRY-RUN MODE]");
  console.log("admin:", admin.id);

  // pipelineStages map (value lookup)
  const stages = await prisma.pipelineStage.findMany({ select: { value: true } });
  const stageValues = new Set(stages.map((s) => s.value));
  console.log("pipelineStages:", stageValues.size);

  // existing leadSources
  const existingLS = await prisma.leadSource.findMany({ select: { id: true, name: true, sortOrder: true } });
  const lsMap = new Map<string, string>(); // name → id
  let maxSort = 0;
  for (const ls of existingLS) {
    lsMap.set(ls.name, ls.id);
    if (ls.sortOrder > maxSort) maxSort = ls.sortOrder;
  }
  // Add NEW_LEAD_SOURCES
  const newLSCreated: string[] = [];
  for (const name of NEW_LEAD_SOURCES) {
    if (!lsMap.has(name)) {
      maxSort += 1;
      if (apply) {
        const created = await prisma.leadSource.create({
          data: { name, sortOrder: maxSort, active: true },
        });
        lsMap.set(name, created.id);
      } else {
        // ドライランではid不要
        lsMap.set(name, `(dry-${name})`);
      }
      newLSCreated.push(name);
    }
  }
  console.log("new lead_sources:", newLSCreated.length, newLSCreated);

  // pull all
  console.log("Fetching Notion pages...");
  const pages = await fetchAllNotionPages();
  console.log("Total Notion pages:", pages.length);

  // counters
  let dealsToCreate = 0;
  let dealsToUpdate = 0;
  let companiesNew = 0;
  let contactsTotal = 0;
  let contactsMatchedByEmail = 0;
  let contactsUnmatched = 0;
  let dealProductsTotal = 0;
  let pipelineStageNullCount = 0;
  const unknownStageValues = new Map<string, number>();
  let ngCount = 0;
  let futureDealCount = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // dryrun: 既存notionPageIdセットだけ取得
  const existing = await prisma.deal.findMany({
    where: { bant: { not: undefined } },
    select: { id: true, bant: true },
  });
  const existingByNotionId = new Map<string, string>();
  for (const d of existing) {
    const b: any = d.bant;
    if (b && typeof b === "object" && b.notionPageId) {
      existingByNotionId.set(b.notionPageId, d.id);
    }
  }
  console.log("existing deals with notionPageId:", existingByNotionId.size);

  // ----- per-page processing -----
  let processed = 0;
  for (const page of pages) {
    processed++;
    const props = page.properties || {};
    const notionPageId: string = page.id;
    const notionPageUrl: string = page.url;
    const notionLastEditedAt: string = page.last_edited_time;

    const companyName = pickTitle(props["会社名"]) || "(名称不明)";
    const websiteUrl = pickUrl(props["HP URL"]);
    const industries = pickMultiSelect(props["業界・業種"]);
    const industry = industries.length > 0 ? industries.join(", ") : null;

    const dealDateStr = pickDate(props["商談日"]);
    const nextActionDateStr = pickDate(props["次回アクション日"]);
    const timeframeStr = pickDate(props["Timeframe（導入時期）"]);
    const nextAction = pickRichText(props["ネクストアクション"]);
    const authority = pickRichText(props["Authority（決裁者名）"]);
    const msMemo = pickRichText(props["MSメモ"]);
    const fiscalMonth = pickSelect(props["決算月"]);
    const alYomi = pickSelect(props["【AL】ヨミ"]);
    const budget = pickSelect(props[" Budget（予算）"]);
    const msLastEditedAt = pickLastEditedTime(props[" MS最終更新日"]);
    const statusRaw = pickSelect(props["ステータス"]);
    const statusNormalized = normalizeStatus(statusRaw);
    const msStatus = pickStatus(props["MSステータス"]);
    const catvYomi = pickSelect(props["CATVヨミ"]);
    const proposalDocUrl = pickUrl(props["ご提案企画書"]);
    const contactNamesRaw = pickRichText(props["先方担当者名"]);
    const isAtackTarget = pickCheckbox(props["アタック企業"]);
    const eizoYomi = pickSelect(props["映像ヨミ"]);
    const planContents = pickMultiSelect(props["企画内容"]);
    const assigneeIds = pickPeopleIds(props["商談担当者"]);
    const planCreatorIds = pickPeopleIds(props["企画作成者"]);
    const proposalAmount = pickNumber(props["提案金額"]);
    const isNG = pickCheckbox(props["NG"]);
    const contactPhone = pickRichText(props["担当者電話番号（携帯）"]);
    const contactEmailsRaw = pickRichText(props["担当者メールアドレス"]);
    const leadSourceName = pickSelect(props["リード"]);
    const snsYomi = pickSelect(props["SNSヨミ "]); // 末尾スペース注意

    // counters
    if (isNG) ngCount++;
    if (dealDateStr) {
      const d = new Date(dealDateStr);
      if (d > today) futureDealCount++;
    }

    // pipelineStage
    let pipelineStage: string | null = null;
    if (statusNormalized) {
      if (stageValues.has(statusNormalized)) {
        pipelineStage = statusNormalized;
      } else {
        pipelineStageNullCount++;
        unknownStageValues.set(
          statusNormalized,
          (unknownStageValues.get(statusNormalized) || 0) + 1
        );
      }
    }

    // leadSource
    const leadSourceId = leadSourceName ? lsMap.get(leadSourceName) || null : null;

    // contacts: 名前リスト × メールリスト
    const names = splitContactNames(contactNamesRaw);
    const emails = splitEmails(contactEmailsRaw);

    // 名前 → email対応表
    const nameEmailPairs: Array<{ name: string | null; email: string | null; note?: string }> = [];
    const usedEmails = new Set<string>();
    const usedNames = new Set<string>();
    // step1: name から email を探す
    for (const n of names) {
      let matched: string | null = null;
      for (const e of emails) {
        if (usedEmails.has(e)) continue;
        const hit = tryMatchEmailToName(e, [n]);
        if (hit) { matched = e; break; }
      }
      if (matched) {
        nameEmailPairs.push({ name: n, email: matched });
        usedEmails.add(matched);
        usedNames.add(n);
        contactsMatchedByEmail++;
      } else {
        nameEmailPairs.push({ name: n, email: null, note: "自動照合不可" });
        usedNames.add(n);
        contactsUnmatched++;
      }
    }
    // step2: emailのうちmatch外を別contactとして
    for (const e of emails) {
      if (usedEmails.has(e)) continue;
      nameEmailPairs.push({ name: null, email: e, note: "自動照合不可" });
      contactsUnmatched++;
    }
    // step3: 名前1つもなく email も無く、電話だけある場合
    if (nameEmailPairs.length === 0 && contactPhone) {
      nameEmailPairs.push({ name: "(電話のみ)", email: null });
    }
    contactsTotal += nameEmailPairs.length;

    // dealProducts: 4ヨミ列を見て、未提案/未商談/null以外をDealProduct化
    const productMappings: Array<{ productName: string; yomiStatus: string }> = [];
    if (eizoYomi && eizoYomi !== "未商談" && eizoYomi !== "未提案") {
      productMappings.push({ productName: "映像", yomiStatus: eizoYomi });
    }
    if (snsYomi && snsYomi !== "未商談" && snsYomi !== "未提案") {
      productMappings.push({ productName: "SNS", yomiStatus: snsYomi });
    }
    if (catvYomi && catvYomi !== "未商談" && catvYomi !== "未提案") {
      productMappings.push({ productName: "CATV", yomiStatus: catvYomi });
    }
    if (alYomi) {
      // 【AL】ヨミは選択肢に「ネタ」「Aヨミ」等が直接入る（プレフィックス無し）
      productMappings.push({ productName: "アライアンス", yomiStatus: alYomi });
    }
    dealProductsTotal += productMappings.length;

    if (existingByNotionId.has(notionPageId)) {
      dealsToUpdate++;
    } else {
      dealsToCreate++;
      companiesNew++;
    }

    if (!apply) continue; // ドライランはここまで

    // ========================================
    // 本投入
    // ========================================
    // bant JSON
    const bant: any = {
      notionPageId,
      notionPageUrl,
      notionLastEditedAt,
      notionAssigneeIds: assigneeIds,
      notionPlanCreatorIds: planCreatorIds,
      msStatus,
      msMemo,
      msLastEditedAt,
      isNG,
      fiscalMonth,
      industry,
      atackTarget: isAtackTarget,
      authority,
      budget,
      timeframe: timeframeStr,
      proposalDocUrl,
      planContents,
      contactPhone,
      leadSourceNameRaw: leadSourceName,
    };

    let dealId: string;
    const existingDealId = existingByNotionId.get(notionPageId);
    if (existingDealId) {
      // update
      const d = await prisma.deal.update({
        where: { id: existingDealId },
        data: {
          title: companyName,
          pipelineStage,
          nextAction,
          nextActionAt: nextActionDateStr ? new Date(nextActionDateStr) : null,
          appointmentDate: dealDateStr ? new Date(dealDateStr) : null,
          leadSourceId,
          bant,
          bantUpdatedAt: new Date(),
        },
      });
      dealId = d.id;

      // 既存company名は更新する（HP/業界も）
      await prisma.company.update({
        where: { id: d.companyId },
        data: { name: companyName, websiteUrl, industry },
      });

      // contacts/dealProducts は全部消して再作成（idempotent）
      await prisma.contact.deleteMany({ where: { companyId: d.companyId } });
      await prisma.dealProduct.deleteMany({ where: { dealId } });

      const companyId = d.companyId;
      for (const pair of nameEmailPairs) {
        await prisma.contact.create({
          data: {
            companyId,
            name: pair.name || "(名前不明)",
            email: pair.email,
            phone: contactPhone || null,
            note: pair.note || null,
          },
        });
      }
      for (const m of productMappings) {
        await prisma.dealProduct.create({
          data: {
            dealId,
            productId: null,
            productName: m.productName,
            yomiStatus: m.yomiStatus,
            amount: proposalAmount ? Math.round(proposalAmount) : null,
            ownerUserId: admin.id,
          },
        });
      }
    } else {
      // create new
      const company = await prisma.company.create({
        data: { name: companyName, websiteUrl, industry },
      });

      const deal = await prisma.deal.create({
        data: {
          companyId: company.id,
          ownerUserId: admin.id,
          title: companyName,
          pipelineStage,
          nextAction,
          nextActionAt: nextActionDateStr ? new Date(nextActionDateStr) : null,
          appointmentDate: dealDateStr ? new Date(dealDateStr) : null,
          leadSourceId,
          bant,
          bantUpdatedAt: new Date(),
        },
      });
      dealId = deal.id;

      for (const pair of nameEmailPairs) {
        await prisma.contact.create({
          data: {
            companyId: company.id,
            name: pair.name || "(名前不明)",
            email: pair.email,
            phone: contactPhone || null,
            note: pair.note || null,
          },
        });
      }
      for (const m of productMappings) {
        await prisma.dealProduct.create({
          data: {
            dealId,
            productId: null,
            productName: m.productName,
            yomiStatus: m.yomiStatus,
            amount: proposalAmount ? Math.round(proposalAmount) : null,
            ownerUserId: admin.id,
          },
        });
      }
    }

    if (processed % 100 === 0) {
      console.log(`  progress: ${processed}/${pages.length}`);
    }
  }

  // ----- summary -----
  console.log("\n========== SUMMARY ==========");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Notion pages pulled : ${pages.length}`);
  console.log(`Deals to create     : ${dealsToCreate}`);
  console.log(`Deals to update     : ${dealsToUpdate}`);
  console.log(`Companies (new)     : ${companiesNew}`);
  console.log(`Contacts total      : ${contactsTotal}`);
  console.log(`  matched by email  : ${contactsMatchedByEmail}`);
  console.log(`  unmatched         : ${contactsUnmatched}`);
  console.log(`DealProducts total  : ${dealProductsTotal}`);
  console.log(`pipelineStage=null  : ${pipelineStageNullCount}`);
  if (unknownStageValues.size > 0) {
    console.log("  unknown values:");
    for (const [k, v] of unknownStageValues.entries()) {
      console.log(`    "${k}" × ${v}`);
    }
  }
  console.log(`NG flagged          : ${ngCount}`);
  console.log(`Future deal dates   : ${futureDealCount}`);
  console.log(`New lead_sources    : ${newLSCreated.length} (${newLSCreated.join(", ")})`);
  console.log("=============================\n");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
